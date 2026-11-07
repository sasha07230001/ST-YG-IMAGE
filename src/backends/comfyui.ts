import { buildSimpleWorkflow } from '@/backends/comfyTemplates';
import { parseSize, pickSize, type Orientation } from '@/backends/size';
import { getContext } from '@/st/context';
import { type ComfyRunConn } from '@/state/settings';

type JsonObject = Record<string, unknown>;
export type ComfyWorkflow = Record<string, JsonObject>;

export interface ComfyTemplateValues {
  prompt: string;
  negative_prompt?: string;
  seed?: number;
  /** 自然语言部分;仅写入显式含 %nl% 的工作流,不自动拼进 %prompt%。 */
  nl?: string;
  /** 画面宽高;仅写入显式含 %width%/%height% 的工作流,缺省时工作流里写死的尺寸原样生效。 */
  width?: number;
  height?: number;
  /** 画幅方向;generateComfyImage 据此从渠道配置解析出 width/height。 */
  size?: Orientation;
}

export interface ComfyImageResult {
  url: string;
  filename: string;
  format: string;
  /** 浏览器直连使用 object URL 时释放资源；data URL 无需释放。 */
  revoke(): void;
}

const SUPPORTED_PLACEHOLDERS = new Set(['prompt', 'negative_prompt', 'seed', 'nl', 'width', 'height']);
const PLACEHOLDER_PATTERN = /%([a-z][a-z0-9_]*)%/g;
const SERVER_BASE = '/api/sd/comfy';
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 生成随机种子（0 ≤ seed < 2^53，与 Python random.randint(0, 2**53 - 1) 同范围）。
 * 必须在发起生成时就生成并显式传值：部分节点（如部分采样器包装）不接受 -1 自动随机。
 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 53);
}

export class ComfyUIError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ComfyUIError';
  }
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 解析并做最低限度的 API 工作流结构校验。 */
export function parseWorkflowTemplate(template: string): ComfyWorkflow {
  if (!template.trim()) throw new ComfyUIError('请先粘贴 ComfyUI API 格式工作流');

  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // 常见笔误：占位符写成了裸值（seed: %seed%），JSON 里必须是字符串（"%seed%"）
    const hint = detail.includes('%')
      ? '；占位符必须写成字符串形式，如 "seed": "%seed%"（带引号）'
      : '';
    throw new ComfyUIError(`工作流 JSON 格式错误：${detail}${hint}`);
  }

  if (!isObject(parsed) || Object.keys(parsed).length === 0) {
    throw new ComfyUIError('工作流必须是非空的 JSON 对象');
  }

  const hasApiNode = Object.values(parsed).some(
    node => isObject(node) && typeof node.class_type === 'string' && isObject(node.inputs),
  );
  if (!hasApiNode) {
    throw new ComfyUIError('未找到 API 格式节点，请在 ComfyUI 中使用「Save (API Format)」导出');
  }

  return parsed as ComfyWorkflow;
}

function collectPlaceholders(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) found.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectPlaceholders(item, found));
    return;
  }
  if (isObject(value)) Object.values(value).forEach(item => collectPlaceholders(item, found));
}

export function getWorkflowPlaceholders(template: string): string[] {
  const workflow = parseWorkflowTemplate(template);
  const found = new Set<string>();
  collectPlaceholders(workflow, found);
  return [...found].sort();
}

function replacePlaceholders(value: unknown, replacements: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^%([a-z][a-z0-9_]*)%$/);
    if (exact && Object.hasOwn(replacements, exact[1])) return replacements[exact[1]];

    return value.replace(PLACEHOLDER_PATTERN, (marker, name: string) =>
      Object.hasOwn(replacements, name) ? String(replacements[name]) : marker,
    );
  }
  if (Array.isArray(value)) return value.map(item => replacePlaceholders(item, replacements));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, replacements)]));
  }
  return value;
}

/**
 * 把模板渲染成可提交工作流。先解析后递归替换，提示词中的引号和换行不会破坏 JSON；
 * 精确等于 %seed% / %width% / %height% 的字符串会被替换为数值，而不是字符串
 * （EmptyLatentImage 的 width/height 必须是数字）。
 *
 * 画幅是 opt-in 的：工作流没写 %width%/%height% 时完全不受影响，尺寸仍由工作流自己决定；
 * 写了却拿不到有效尺寸才报错，提示去面板补配置——静默按默认值出图会让用户以为设置生效了。
 *
 * **没有 %prompt% 时不再报错**:改走「定位式」(applyPromptToClipNodes)——
 * 自动找 CLIPTextEncode 把正/负提示词写进去。老版本这里是硬报错,
 * 但用户手上绝大多数工作流是 ComfyUI 里「Save (API Format)」直出的,
 * 里面压根没有占位符;那条路只能粘进来就报错,体验上等于不支持自定义工作流。
 * 占位符与定位式可以共存:写了 %prompt% 的节点按占位符走,没写的节点一概不碰文字。
 */
export function renderWorkflowTemplate(template: string, values: ComfyTemplateValues): ComfyWorkflow {
  const workflow = parseWorkflowTemplate(template);
  const found = new Set<string>();
  collectPlaceholders(workflow, found);

  const unsupported = [...found].filter(name => !SUPPORTED_PLACEHOLDERS.has(name));
  if (unsupported.length) throw new ComfyUIError(`工作流含暂不支持的占位符：${unsupported.map(x => `%${x}%`).join('、')}`);

  const needsSize = found.has('width') || found.has('height');
  if (needsSize && !(values.width && values.height)) {
    throw new ComfyUIError('工作流用到了 %width%/%height%，请先在 ComfyUI 渠道页填写竖屏与横屏尺寸（如 832×1216）');
  }

  const seed = values.seed ?? randomSeed();
  const rendered = replacePlaceholders(workflow, {
    prompt: values.prompt,
    negative_prompt: values.negative_prompt ?? '',
    nl: values.nl ?? '',
    width: values.width ?? 0,
    height: values.height ?? 0,
    seed,
  }) as ComfyWorkflow;

  if (found.has('prompt')) return rendered;
  return applyPromptToClipNodes(rendered, values.prompt, values.negative_prompt ?? '');
}

/** 会被当成「文本编码节点」的类名(含社区常见变体)。 */
const CLIP_TEXT_NODE_TYPES = new Set([
  'CLIPTextEncode',
  'CLIPTextEncodeSDXL',
  'CLIPTextEncodeSDXLRefiner',
  'CLIPTextEncodeFlux',
  'BNK_CLIPTextEncodeAdvanced',
]);

/** 节点里承载文字的字段名(各家节点叫法不同,按优先级取第一个存在的)。 */
const CLIP_TEXT_FIELDS = ['text', 'text_g', 'prompt', 'positive', 'clip_l', 't5xxl'];

interface ClipNodeHit {
  id: string;
  field: string;
  text: string;
}

/** 收集工作流里所有「文本编码节点」及其当前文字。 */
function clipTextNodes(workflow: ComfyWorkflow): ClipNodeHit[] {
  const hits: ClipNodeHit[] = [];
  for (const [id, node] of Object.entries(workflow)) {
    if (!isObject(node) || typeof node.class_type !== 'string') continue;
    if (!CLIP_TEXT_NODE_TYPES.has(node.class_type)) continue;
    const inputs = node.inputs;
    if (!isObject(inputs)) continue;
    for (const field of CLIP_TEXT_FIELDS) {
      const value = inputs[field];
      if (typeof value === 'string') {
        hits.push({ id, field, text: value });
        break;
      }
    }
  }
  return hits;
}

/**
 * 「定位式」写入:没有 %prompt% 占位符时,把提示词写进工作流里的文本编码节点。
 *
 * 选节点的口径刻意简单且可预测:
 * 1. 先看节点**原来就写着东西**的(非空);都为空的退而求其次按图序取前两个;
 * 2. 同一侧若有多个节点、其中一个的文字明显像负面词(negative / lowres / worst quality…),
 *    先把它分到负面侧;
 * 3. 分不出正负时按节点 id 顺序:第一个写正面,其余写负面。
 *
 * 这样做是为了「粘进来就能用」:从 ComfyUI 直出的工作流没有任何标记,
 * 用户不该为了配这张图去学 SetNode/占位符语法。真的需要精细控制时,
 * 在工作流里写 %prompt% / %negative_prompt% 即可,那时本函数完全不介入。
 */
export function applyPromptToClipNodes(
  workflow: ComfyWorkflow,
  prompt: string,
  negative: string,
): ComfyWorkflow {
  const hits = clipTextNodes(workflow).sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
  if (!hits.length) {
    throw new ComfyUIError(
      '工作流中既没有 %prompt% 占位符,也没有可写入的 CLIPTextEncode 节点：请在工作流的 CLIPTextEncode 的 text 里写 %prompt%',
    );
  }

  const looksNegative = (text: string) =>
    /(negative|lowres|worst quality|low quality|bad anatomy|bad hands|watermark)/i.test(text);

  const filled = hits.filter(hit => hit.text.trim());
  const pool = filled.length ? filled : hits;
  const negHinted = pool.filter(hit => looksNegative(hit.text));
  const positiveNode = pool.find(hit => !looksNegative(hit.text)) ?? pool[0];
  const negativeNode =
    negHinted.find(hit => hit.id !== positiveNode.id) ??
    pool.find(hit => hit.id !== positiveNode.id && hit.field !== positiveNode.field) ??
    null;

  const next: ComfyWorkflow = { ...workflow };
  const write = (hit: ClipNodeHit, text: string) => {
    const node = next[hit.id];
    if (!isObject(node) || !isObject(node.inputs)) return;
    next[hit.id] = { ...node, inputs: { ...node.inputs, [hit.field]: text } };
  };
  write(positiveNode, prompt);
  if (negativeNode && negative.trim()) write(negativeNode, negative);
  return next;
}

function endpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function responseError(response: Response, label: string): Promise<ComfyUIError> {
  const text = (await response.text().catch(() => '')).trim();
  return new ComfyUIError(`${label} (${response.status})${text ? `：${text.slice(0, 500)}` : ''}`, response.status);
}

/**
 * 请求通道自动选择。策略:
 * 1. 浏览器直连优先(延迟最低,不占 ST 服务端);
 * 2. 仅当请求「根本没送达后端」的网络级失败(fetch TypeError:CORS 拦截/拒连/断网)时,
 *    回退到 ST 后端转发;
 * 3. HTTP 状态错误是服务端真实反馈,不重试——转发过去结果一样;
 * 4. 用户主动取消(AbortError)一律直接抛出。
 * 两个通道都通时「优先浏览器直连」天然成立:直连成功就不试转发,无需探测、无缓存过期问题。
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError;
}

function requireContext() {
  const context = getContext();
  if (!context) throw new ComfyUIError('SillyTavern 上下文不可用');
  return context;
}

export interface ComfyTestResult {
  /** 实际打通的通道:browser=浏览器直连;server=ST 后端转发 */
  mode: 'browser' | 'server';
}

export async function testComfyConnection(conn: ComfyRunConn, signal?: AbortSignal): Promise<ComfyTestResult> {
  if (!conn.url.trim()) throw new ComfyUIError('请先填写 ComfyUI 服务地址');

  // 浏览器直连优先;仅网络级失败(CORS/拒连)才回退 ST 后端转发
  try {
    const response = await fetch(endpoint(conn.url, 'system_stats'), { signal });
    if (!response.ok) throw await responseError(response, '浏览器连接 ComfyUI 失败');
    return { mode: 'browser' };
  } catch (error) {
    if (!isNetworkError(error)) throw error;
  }

  const context = requireContext();
  const response = await fetch(`${SERVER_BASE}/ping`, {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({ url: conn.url.trim() }),
    signal,
  });
  if (!response.ok) throw await responseError(response, 'ST 后端连接 ComfyUI 失败');
  return { mode: 'server' };
}

interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

function findOutputFile(item: unknown): ComfyOutputFile | null {
  if (!isObject(item) || !isObject(item.outputs)) return null;
  for (const output of Object.values(item.outputs)) {
    if (!isObject(output)) continue;
    for (const key of ['images', 'gifs']) {
      const files = output[key];
      if (!Array.isArray(files)) continue;
      const file = files.find(x => isObject(x) && typeof x.filename === 'string');
      if (file) return file as unknown as ComfyOutputFile;
    }
  }
  return null;
}

function executionError(item: unknown): string | null {
  if (!isObject(item) || !isObject(item.status)) return null;
  if (item.status.status_str !== 'error') return null;
  const messages = item.status.messages;
  if (!Array.isArray(messages)) return 'ComfyUI 工作流执行失败';

  const details = messages
    .filter(message => Array.isArray(message) && message[0] === 'execution_error' && isObject(message[1]))
    .map(message => {
      const data = message[1] as JsonObject;
      return `${String(data.node_type ?? '节点')} [${String(data.node_id ?? '?')}]：${String(data.exception_message ?? data.exception_type ?? '执行失败')}`;
    });
  return details.length ? details.join('\n') : 'ComfyUI 工作流执行失败';
}

function executionCompleted(item: unknown): boolean {
  return isObject(item) && isObject(item.status) && item.status.completed === true;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('已取消', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function fileFormat(filename: string, mime = ''): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension && /^[a-z0-9]+$/.test(extension)) return extension;
  return mime.split('/').pop()?.toLowerCase() || 'png';
}

async function generateViaServer(
  conn: ComfyRunConn,
  workflow: ComfyWorkflow,
  signal?: AbortSignal,
): Promise<ComfyImageResult> {
  const context = requireContext();
  const response = await fetch(`${SERVER_BASE}/generate`, {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({
      url: conn.url.trim(),
      prompt: JSON.stringify({ prompt: workflow }),
    }),
    signal,
  });
  if (!response.ok) throw await responseError(response, 'ComfyUI 生图失败');

  const data = (await response.json()) as { format?: unknown; data?: unknown };
  if (typeof data.data !== 'string' || !data.data) throw new ComfyUIError('ST 后端未返回图片数据');
  const format = typeof data.format === 'string' && data.format ? data.format.toLowerCase() : 'png';
  return {
    url: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${data.data}`,
    filename: `comfy-${Date.now()}.${format}`,
    format,
    revoke() {},
  };
}

async function queueDirect(
  conn: ComfyRunConn,
  workflow: ComfyWorkflow,
  signal?: AbortSignal,
): Promise<string> {
  const queued = await fetch(endpoint(conn.url, 'prompt'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal,
  });
  if (!queued.ok) throw await responseError(queued, 'ComfyUI 拒绝了工作流');
  const queuedData = (await queued.json()) as { prompt_id?: unknown; node_errors?: unknown };
  if (typeof queuedData.prompt_id !== 'string' || !queuedData.prompt_id) {
    throw new ComfyUIError(`ComfyUI 未返回 prompt_id${queuedData.node_errors ? `：${JSON.stringify(queuedData.node_errors).slice(0, 500)}` : ''}`);
  }
  return queuedData.prompt_id;
}

/** GET /queue 的条目形如 [number, prompt_id, prompt, extra_data, outputs_to_execute]。 */
type QueueEntry = [number, string, ...unknown[]];

interface QueuePosition {
  /** 任务正在执行。 */
  running: boolean;
  /** 前面还有几个任务;running 时为 0;任务已不在队列(执行完/被删)为 null。 */
  ahead: number | null;
}

function isQueueEntry(value: unknown): value is QueueEntry {
  return Array.isArray(value) && typeof value[1] === 'string';
}

/**
 * 查任务在 ComfyUI 服务端队列里的位置。
 * 取不到/解析不了一律返回 null——排队位置只是展示信息,不值得中断出图(降级优先)。
 *
 * 「前面几个」按优先级序号(条目 index 0)比较,不用数组下标:
 * queue_pending 是堆结构的原始快照,列表顺序不等于执行顺序。
 */
async function fetchQueuePosition(
  conn: ComfyRunConn,
  promptId: string,
  signal?: AbortSignal,
): Promise<QueuePosition | null> {
  try {
    const response = await fetch(endpoint(conn.url, 'queue'), { signal });
    if (!response.ok) return null;
    const data = (await response.json()) as JsonObject;
    // 两个键都必须是数组才算有效快照(空数组 = 队列真的空了,是有效信息)。
    // 形状不对 = 响应不可信,按「位置未知」处理——不能当成「任务已结束」,
    // 否则取消时会只发 delete,漏掉对正在跑的任务的中断。
    if (!Array.isArray(data.queue_running) || !Array.isArray(data.queue_pending)) return null;
    const running = data.queue_running.filter(isQueueEntry);
    const pending = data.queue_pending.filter(isQueueEntry);

    if (running.some(entry => entry[1] === promptId)) return { running: true, ahead: 0 };
    const mine = pending.find(entry => entry[1] === promptId);
    if (!mine) return { running: false, ahead: null };
    // 正在执行的那个也算在前面
    const ahead = pending.filter(entry => entry[0] < mine[0]).length + running.length;
    return { running: false, ahead };
  } catch {
    return null;
  }
}

/**
 * 取消一个已入队的任务。
 *
 * 必须分情况——ComfyUI 的两个接口各管一段,用错了会取消到别人:
 * - 任务还在排队 → POST /queue {delete:[id]} 把它摘出队列;`/interrupt` 对它无效。
 * - 任务正在执行 → POST /interrupt 中断,并带上 prompt_id。
 * - 队列位置查不到(接口 502/解析失败,position=null):**两条都发**。
 *   delete 摘不到是无害空操作;interrupt 带 prompt_id,新版据此校验,只有确实在跑的
 *   才会被中断。若只发 delete,「正在跑但查不到位置」会漏中断、白烧 GPU 到跑完。
 *
 * 反过来若不查队列就无脑 /interrupt:并发出图时取消排在后面的任务,
 * 打断的会是正在跑的**别的**任务(旧版无视 body 里的 prompt_id,必现)。
 *
 * 残留竞态(已知、可接受):查队列与发 interrupt 之间有一个往返,期间我们的任务可能刚跑完、
 * 下一个刚开始——此时旧版 ComfyUI(无视 prompt_id)会误伤下一个任务。
 * 带上 prompt_id 让新版免疫;旧版无法从客户端根治(没有「按 id 中断」的接口),
 * 故只在确认自己在跑时才发 interrupt,把窗口压到最小。
 */
async function cancelPrompt(conn: ComfyRunConn, promptId: string): Promise<void> {
  // 此处不传 signal:调用方的 signal 正是「已取消」本身,带上会让清理请求当场夭折。
  const position = await fetchQueuePosition(conn, promptId);
  const post = (path: string, body: JsonObject) =>
    fetch(endpoint(conn.url, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    if (position?.running) {
      await post('interrupt', { prompt_id: promptId });
      return;
    }
    if (position) {
      // 位置已确认:在排队(ahead>=0)或已结束(ahead=null),都只需摘队列
      await post('queue', { delete: [promptId] });
      return;
    }
    // 位置未知:两条都发,谁生效算谁
    await Promise.allSettled([
      post('queue', { delete: [promptId] }),
      post('interrupt', { prompt_id: promptId }),
    ]);
  } catch {
    /* 取消是尽力而为:网络失败就让它跑完,结果没人接收 */
  }
}

export interface ComfyProgressHooks {
  /** 排队位置变化:0=已在执行,n>0=前面还有 n 个,null=未知。 */
  onQueue?(ahead: number | null): void;
}

async function pollDirectResult(
  conn: ComfyRunConn,
  promptId: string,
  signal?: AbortSignal,
  hooks?: ComfyProgressHooks,
): Promise<ComfyImageResult> {
  const onAbort = () => {
    void cancelPrompt(conn, promptId);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const startedAt = Date.now();
    let file: ComfyOutputFile | null = null;
    // 一旦观察到自己在执行就不再查队列:位置信息已无意义,省掉每轮一次请求
    let watchQueue = !!hooks?.onQueue;
    while (!file) {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) throw new ComfyUIError('等待 ComfyUI 结果超时（10 分钟）');
      const historyResponse = await fetch(endpoint(conn.url, `history/${encodeURIComponent(promptId)}`), { signal });
      if (!historyResponse.ok) throw await responseError(historyResponse, '读取 ComfyUI 任务状态失败');
      const history = (await historyResponse.json()) as JsonObject;
      const item = history[promptId];
      const error = executionError(item);
      if (error) throw new ComfyUIError(error);
      file = findOutputFile(item);
      if (!file && executionCompleted(item)) {
        throw new ComfyUIError('工作流已执行完成，但没有找到图片输出；请确认工作流包含 SaveImage 或 PreviewImage 节点');
      }
      if (file) break;
      if (watchQueue) {
        const position = await fetchQueuePosition(conn, promptId, signal);
        hooks?.onQueue?.(position?.ahead ?? null);
        if (position?.running || position?.ahead === null) watchQueue = false;
      }
      await abortableDelay(POLL_INTERVAL_MS, signal);
    }

    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder ?? '',
      type: file.type ?? 'output',
    });
    const imageResponse = await fetch(`${endpoint(conn.url, 'view')}?${query}`, { signal });
    if (!imageResponse.ok) throw await responseError(imageResponse, '读取 ComfyUI 输出图片失败');
    const blob = await imageResponse.blob();
    const url = URL.createObjectURL(blob);
    return {
      url,
      filename: file.filename,
      format: fileFormat(file.filename, blob.type),
      revoke: () => URL.revokeObjectURL(url),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function generateComfyImage(
  conn: ComfyRunConn,
  values: ComfyTemplateValues,
  signal?: AbortSignal,
  hooks?: ComfyProgressHooks,
): Promise<ComfyImageResult> {
  if (!conn.url.trim()) throw new ComfyUIError('请先填写 ComfyUI 服务地址');
  if (!values.prompt.trim()) throw new ComfyUIError('正向提示词不能为空');
  // 按方向取渠道配置里的尺寸;解析不出就传空,由 renderWorkflowTemplate 决定是报错还是无视
  // (工作流没用 %width%/%height% 时,尺寸配错了也不该妨碍出图)
  const size = values.width && values.height
    ? { width: values.width, height: values.height }
    : parseSize(pickSize(conn, values.size ?? 'portrait'));
  // 两模式互斥的分叉点:simple 由模板组装(无占位符),custom 走宏渲染。
  // 汇合点即「拿到可提交 JSON」,之后的排队/轮询/取消完全共用。
  let workflow: ComfyWorkflow;
  if (conn.mode === 'simple') {
    try {
      workflow = buildSimpleWorkflow(conn.simple, {
        prompt: values.prompt,
        nl: values.nl,
        negative: values.negative_prompt,
        seed: values.seed ?? randomSeed(),
        width: size?.width ?? 0,
        height: size?.height ?? 0,
      });
    } catch (error) {
      throw new ComfyUIError(error instanceof Error ? error.message : String(error));
    }
  } else {
    workflow = renderWorkflowTemplate(conn.workflow, { ...values, ...size });
  }

  // 通道自动选择:浏览器直连优先;仅当请求根本没送达 ComfyUI(网络级失败)时回退 ST 后端转发。
  // 回退只发生在「排队」之前——拿到 prompt_id 后任务已入队,轮询阶段的任何失败都不重发,避免重复生图。
  let queued = false;
  try {
    const promptId = await queueDirect(conn, workflow, signal);
    queued = true;
    return await pollDirectResult(conn, promptId, signal, hooks);
  } catch (error) {
    if (queued || signal?.aborted || !isNetworkError(error)) throw error;
    return generateViaServer(conn, workflow, signal);
  }
}
