/**
 * 「一次出图」的共用中段 —— 楼层卡片与公开接口的唯一生成入口。
 *
 * 原本这段活全写在 Card.vue 的 generate() 里,与槽位运行态(beginGen/failGen)、
 * 落盘(saveImageResult)、重水合(hydrateMessage)缠在一起。公开接口要让第三方
 * 「自己决定图显示在哪」,要的恰恰是**掐头去尾的中段**:
 *
 *   前(调用方):登记运行态 / 校验参数
 *   ★ 中(本模块):NAI 闸门 → 按 backend 分派 → 拿到图
 *   后(调用方):落盘、显示、收尾埋点
 *
 * **闸门不可绕过**,这是本模块存在的首要理由:直接调 backends/nai.ts 的
 * generateNaiImage 会跑在 floor/genQueue.ts 的并发闸门与全局节奏之外,0.2.0 整版的
 * NAI 限流自愈(429 全局冷却、相邻请求最小间隔、退避重试)当场失效。第三方并发调用
 * 是常态,绕过去的症状是用户 NAI 账号吃一串密集 429 —— 而用户只会认为YG坏了。
 * 故公开接口与卡片共用本函数,闸门在这里包死。
 *
 * 本模块**刻意不碰**:楼层坐标、genState、extra、水合、请求历史埋点。
 * 埋点留给调用方是有意为之:一条历史记录的「成功」判据各家不同——楼层卡片要等
 * saveImageResult 落盘成功才算成,还要把「图拿到了却因任务被取代而丢弃」记成已取消;
 * 本模块只知道请求本身的成败,替调用方下结论会把那两种情形谎报成成功。
 * 故 decideSeed 单独导出:调用方先定种子(埋点需要它)、再把它显式传进来。
 */

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { comfySimpleParams, composeCustomNegative, composeCustomPositive, composeNegative, composePositive, validateSimpleConfig, type SimpleGenValues } from '@/backends/comfyTemplates';
import { generateComfyImage, randomSeed, type ComfyImageResult } from '@/backends/comfyui';
import { generateNaiImage, naiRandomSeed, naiSupportsCharacterPrompts } from '@/backends/nai';
import { effectiveOrientation, parseSize, pickSize, type Orientation } from '@/backends/size';
import { acquireNaiSlot } from '@/floor/genQueue';
import type { GenerationMeta } from '@/generationMeta';
import { chatProfiles, findProfile, profileEntryTag } from '@/state/charProfiles';
import { activeComfyPreset, activeNaiEndpoint, activeOrientationLock, effectiveComfyConn, effectiveNai, settings, type BackendId } from '@/state/settings';
import {
  characterLayerText,
  listCharacterPromptRows,
  resolveCharacterPrompts,
} from '@/state/characterPromptStore';
import { appendCharacterPrompts, pickPresentNames } from '@/autoTag/characterPrompts';
import { composeProfilesForPresent, resolvePresentProfiles } from '@/state/charProfiles';

/** 一次生成的输入。与协议层 ImageInsertion 同形,但不含正文位置信息。 */
export interface GenerateInput {
  /** 正向 danbooru 短 tag。 */
  prompt: string;
  /** 自然语言部分(可空)。 */
  nl?: string;
  /** 本画面动态负面(可空)。ComfyUI 走 %negative_prompt%;NAI 的负面取渠道配置,不吃这个。 */
  negative?: string;
  /** NAI 4.5/V5 原生多角色提示;ComfyUI 不支持(见 charactersApplied)。 */
  characters?: ImageCharacterPrompt[];
  /**
   * 画幅方向;缺省竖屏。具体像素取渠道配置里的横竖尺寸。
   * 渠道锁定了方向(activeOrientationLock)时一律按锁定方向出,这里传什么都不算数。
   */
  size?: Orientation;
  /** 本次种子。由调用方经 decideSeed() 先行确定(埋点要在发请求前拿到它)。 */
  seed: number;
}

/** 生成过程中的进度上报(卡片用它显示排队位置与退避进度)。 */
export interface GenerateProgress {
  /** 已取得闸门槽位、请求即将发出(NAI 从「排队中」进入「生成中」的时机)。 */
  onStart?: () => void;
  /** ComfyUI 服务端队列里前面还有几个;null = 未知。 */
  onQueue?: (ahead: number | null) => void;
  /** NAI 限流退避进度;传 null 表示已不在退避中。 */
  onRetry?: (retry: { attempt: number; max: number } | null) => void;
}

/**
 * 角色档案提示词的取用开关。**默认全开**,公开接口显式关掉——
 * 那条路是第三方插件自己发起的出图,不该在用户不知情时把他的角色私设一起送进去。
 */
export interface CharacterPromptOptions {
  /** 是否追加常驻/临时提示词。默认 true。 */
  enabled?: boolean;
  /** 只要通用常驻词,不带任何角色级内容。默认 false。 */
  generalOnly?: boolean;
  /** 当前楼层(用于淘汰过期临时词);缺省取聊天最后一条。 */
  floor?: number;
  /** 是否先重读 chatMetadata。默认 true;公开接口传 false。 */
  reload?: boolean;
}

export interface GenerateOutput {
  result: ComfyImageResult;
  /** 本次实际使用的种子(原样回传,调用方不必自己记)。 */
  seed: number;
  /** 本次实际出图的画幅方向(渠道锁定时即锁定方向,可能与入参 size 不同)。 */
  size: Orientation;
  backend: BackendId;
  /**
   * characters 是否真的发给了后端。
   * ComfyUI 链路**不支持**多角色提示(comfyui.ts / comfyTemplates.ts 全程不读该字段),
   * 传了也是静默丢弃 —— 故显式回报,调用方据此决定要不要提示用户换后端。
   * 不在这里「降级拼进 prompt」:那正是 0.2.3 修掉的重叠躯干问题(一张图里多份完整外貌)。
   */
  charactersApplied: boolean;
  /**
   * 本次实际使用的画师串 / vibe / 采样参数 / 模型，供落盘随图记录（见 generationMeta.ts）。
   * NAI 的画师串与 vibe 不在 tag 文本里，不在这里冒泡出去就只能永久丢失。
   */
  meta: GenerationMeta;
  /**
   * 本次实际追加到 CLIP 文本末尾的「角色档案提示词」(常驻 + 临时合成结果,可为空串)。
   *
   * 为什么冒泡出来:它**不在 tag 文本里**(tag 原文只记模型写的东西),
   * 不在这里带出去就只能永久丢失 —— 用户事后想复现这张图、或者想知道
   * 「为什么这张多出了 black lace bra」,没这条线索就查不了。
   */
  characterPrompt: string;
}

/** 后端就绪状态。 */
export interface BackendStatus {
  backend: BackendId;
  configured: boolean;
  /** NAI 为模型名;ComfyUI 为当前工作流预设名。 */
  model: string;
  /** 当前后端是否支持 characters(NAI 4.5/V5 为 true,ComfyUI 恒 false)。 */
  supportsCharacters: boolean;
  /** configured=false 时的人话原因;已就绪为空串。 */
  reason: string;
}

/**
 * 当前后端能不能出图。**唯一判据**,卡片(configured)与公开接口共用。
 *
 * ComfyUI 要按模式分别校验(custom 要工作流 JSON;simple 要模型/VAE/CLIP 选齐,
 * 与出图组装同一口径 validateSimpleConfig,避免「卡片能点、出图才报错」);NAI 要 url + key。
 */
export function backendStatus(): BackendStatus {
  const backend = settings.defaultBackend;

  if (backend === 'nai') {
    const model = settings.nai.model;
    // 支持与否只看模型,与配没配齐无关:第三方要在出图前就知道该不该传 characters
    const supportsCharacters = naiSupportsCharacterPrompts(model);
    const base = { backend, model, supportsCharacters };
    // 地址与 key 取**当前接入点**那一份(见 effectiveNai);渠道级 nai.url/nai.key 是存量字段。
    // reason 里刻意**不带接入点名字**:它会经 getBackendStatus 原样递给第三方,而名字是用户
    // 自己敲的——有人就拿站点域名当名字,带上等于把地址漏进公开返回值(见 public/api.ts 白名单)。
    // 少了名字也不难定位:面板下拉里选中的就是这条。
    const conn = activeNaiEndpoint();
    if (!conn.url.trim()) {
      return { ...base, configured: false, reason: '当前 NAI 接入点未填写服务地址' };
    }
    if (!conn.key.trim()) {
      return { ...base, configured: false, reason: '当前 NAI 接入点未填写 API Key' };
    }
    return { ...base, configured: true, reason: '' };
  }

  if (backend === 'comfyui') {
    const preset = activeComfyPreset();
    const base = { backend, model: preset.name, supportsCharacters: false };
    if (!settings.comfyui.url.trim()) {
      return { ...base, configured: false, reason: '未填写 ComfyUI 服务地址' };
    }
    if (preset.mode === 'simple') {
      const invalid = validateSimpleConfig(preset.simple);
      if (invalid) return { ...base, configured: false, reason: invalid };
      return { ...base, configured: true, reason: '' };
    }
    if (!preset.workflow.trim()) {
      return { ...base, configured: false, reason: '当前工作流预设未填写工作流 JSON' };
    }
    return { ...base, configured: true, reason: '' };
  }

  // webui 只剩存量类型(设置迁移会把它归一成 comfyui/nai),真出现就是「没选后端」
  return {
    backend,
    configured: false,
    model: '',
    supportsCharacters: false,
    reason: '出图后端未选择,请在YG「渠道」页选择出图渠道',
  };
}

/**
 * 定本次种子。**必须在发请求前定好**:一是部分采样器节点不接受 -1 自动随机,
 * 二是埋点与落盘(entry.seed)都要记下它,事后「同种子再来一张」才有依据。
 *
 * 口径:显式指定 > NAI 面板固定种子(>0)> 随机。
 * NAI 与 ComfyUI 的随机上界不同(各自协议的合法范围),故分开取。
 */
export function decideSeed(backend: BackendId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  if (backend === 'nai') return settings.nai.seed > 0 ? settings.nai.seed : naiRandomSeed();
  return randomSeed();
}

/**
 * 按当前设置出一张图。**楼层卡片与公开接口的唯一生成路径。**
 *
 * 不负责落盘、不负责显示、不登记运行态、不做埋点 —— 那些是调用方的事。
 * signal 一路透传到 fetch/轮询;取消时抛 AbortError(DOMException)。
 *
 * 闸门纪律(见 floor/genQueue.ts):NAI 路径必须持槽发请求,release 放在 finally,
 * 漏一格就永久少一格并发。
 */
export async function generateImage(
  input: GenerateInput,
  signal?: AbortSignal,
  progress: GenerateProgress = {},
  /** 角色档案提示词的取用开关(常驻 / 临时);默认全开,公开接口会显式关掉。 */
  characterPrompts: CharacterPromptOptions = {},
): Promise<GenerateOutput> {
  const status = backendStatus();
  // 兜底:卡片侧已用 configured 拦在按钮上,公开接口侧也会先报 not_configured。
  // 真漏到这里说明上游判据漂了,宁可明说也别发一个注定 401/404 的请求。
  if (!status.configured) throw new Error(status.reason || '出图后端未配置');

  const isNai = status.backend === 'nai';
  const characters = input.characters ?? [];
  /**
   * 简易模式 + 分层开启时,角色提示词不再由后端静默丢弃,而是作为「角色层」
   * 拼进正面提示词(见 backends/promptLayers.ts),这条也算 charactersApplied。
   * custom 模式没有角色位(工作流里只有 %prompt%),分层开了也不该谎报。
   */
  const comfyConn = isNai ? null : effectiveComfyConn();
  const comfyLayered =
    comfyConn !== null && comfyConn.mode === 'simple' && comfyConn.simple.layered !== false;
  // 支持与否由后端说了算:NAI 看模型是否 4.5/V5;ComfyUI 看是否简易模式 + 分层开启
  const charactersApplied = characters.length > 0 && (status.supportsCharacters || comfyLayered);

  /**
   * 角色档案提示词(常驻 + 临时)——**在这里追加,不是在各后端里**。
   *
   * 放在 generateImage 的原因:它是楼层卡片与公开接口的**唯一**出图路径,
   * 接在此处才能保证「不管谁出图、走 ComfyUI 还是 NAI,只要用户开了就都带上」。
   * 放各后端里会漂:ComfyUI 的 custom/simple 两条分支 + NAI 一条,漏一处就是一处静默失效。
   *
   * 在场角色取 characters[](NAI 4.5/V5 的结构化多角色),ComfyUI 那条链不传该字段,
   * 于是退化为「只取通用常驻词 + 无法判定在场者时不带角色级内容」——
   * 宁可少带,也不能把不在场角色的穿着写进这张图(那是凭空多一个人的头号成因)。
   */
  /**
   * 角色档案的**候选名单**(还没判定谁在场):通用常驻词与全部建档角色的名字。
   * 真正的在场判定在下面 present 那一段 —— 候选名单只用来知道「库里有哪些人」。
   */
  const candidates =
    characterPrompts.enabled === false
      ? { text: '', names: [] as string[] }
      : resolveCharacterPrompts({
          floor: characterPrompts.floor,
          present: characters.map(character => character.name).filter(Boolean),
          generalOnly: characterPrompts.generalOnly === true,
          // 楼层卡片走默认的 reload:用户可能刚在角色页改过常驻词
          reload: characterPrompts.reload !== false,
        });
  const nl = input.nl ?? '';
  /**
   * custom 模式(自定义工作流)唯一的提示词入口就是 %prompt%:固定正面(当前工作流的
   * simple.positive 那一格,自定义模式也照填不误)、角色常驻/临时档案、AI 编译出的
   * 画面词必须**在这里**先合成一串再交给工作流,否则角色层与画风词会整段消失。
   *
   * 简易模式不在这里合成:它有自己的 simple.positive 与分层开关,由
   * composePositive 在后端组装阶段拼接(同一个 buildPromptLayers 实现,口径一致)。
   */
  /**
   * 固定正面 / 固定负面。
   *
   * **两种模式共用同一格**：「渠道」页那套工作流的「提示词」框就是用户的基线词,
   * 简易模式拼进 CLIP,custom 模式拼进 %prompt% / %negative_prompt%。
   * 以前 custom 模式的固定负面整段发不出去(只发 AI 的本图排除词),用户填了没反应,
   * 所以这里改成:custom 也走同一个 simple.negative,与 AI 动态负面分层合并。
   */
  const customPreset = activeComfyPreset();
  const customLayered = customPreset.mode === 'custom' && customPreset.simple.layered !== false;
  // 固定正面:两种模式都取「渠道」页当前工作流的「正面提示词」那一格;留空就不硬塞任何画风词。
  const fixedPositive = String(customPreset.simple.positive ?? '').trim();
  // 固定负面同理:简易模式交给 composeNegative,custom 模式由 composeCustomNegative 拼。
  const fixedNegative = customPreset.simple.negative ?? '';

  /**
   * **角色层成品串** —— 与「渠道」页那张可见列表逐字同源(`characterLayerText`)。
   *
   * 0.7 这里曾经自己算一遍:先 `resolvePresentProfiles` 判在场,再 `composeProfilesForPresent`
   * 取词,再加档案库兜底。问题是界面那边算的是另一遍,于是出现「渠道页列着 1 个角色、
   * 旁边预览说 0 tag」—— 用户没法判断哪个才是真发出去的。
   *
   * 现在只有一个来源:那条可见列表的每一行(= 档案固定外貌 + 手写追加词 + 此刻穿戴),
   * 连起来就是角色层。一个角色都没认出在场时不再整段消失,因为这张表本身只列
   * 本聊天建档过的角色,少带一个人的代价远大于多带(buildPromptLayers 跨层去重)。
   * 通用常驻词(不分角色的那格)仍然单独接在后面。
   */
  const profileText =
    characterPrompts.enabled === false ? '' : characterLayerText();
  const presentNames =
    characterPrompts.enabled === false ? [] : listCharacterPromptRows().map(row => row.name);
  const presentArchive = {
    text: [candidates.text, profileText].filter(part => !!String(part ?? '').trim()).join(', '),
    names: presentNames,
  };
  /** 最终进提示词的角色层:在场者的常驻 + 临时词,接在剧情 tag 之后。 */
  const prompt = appendCharacterPrompts(input.prompt, presentArchive.text);

  let release: (() => void) | null = null;
  try {
    // 持槽:取到槽位后本函数内一直持有,直到 finally 释放
    if (isNai) release = await acquireNaiSlot(signal);
    progress.onStart?.();

    // 画幅锁在这里统一生效(卡片与公开接口同走本函数):只决定这一次用哪格尺寸,
    // tag 里记的方向原样不动——promptHash 吃 tag 原文,改写会让老图无辜变 stale。
    const size = effectiveOrientation(activeOrientationLock(), input.size ?? 'portrait');
    /**
     * 这一次实际用的像素。必须**在发请求之前**算出来并显式传给两个后端:
     * 以前只在请求后算一次给 meta 记档用,custom 模式的值全落到 0 —— 工作流里的
     * %width%/%height% 于是被替换成 0/None,ComfyUI 直接 400
     * (invalid_input_type: Failed to convert an input value to a INT value)。
     */
    const pixels = parseSize(pickSize(comfyConn ?? effectiveComfyConn(), size));
    let result: ComfyImageResult;
    let meta: GenerationMeta;
    if (isNai) {
      const output = await generateNaiImage(
        effectiveNai(),
        // characters 原样透传:不支持的模型由 buildNaiParameters 自己滤掉(同一口径
        // naiSupportsCharacterPrompts),在这儿再滤一遍只会多一处会漂的判据
        { prompt, nl, characters, seed: input.seed, size },
        signal,
        { onRetry: info => progress.onRetry?.({ attempt: info.attempt, max: info.max }) },
      );
      result = output.result;
      meta = { backend: 'nai', model: status.model, ...output.usage };
    } else {
      const conn = comfyConn ?? effectiveComfyConn();
      // custom 模式:三层在这里合成成最终那一串 %prompt%。简易模式保持原样,交给后端。
      const customPrompt =
        conn.mode === 'custom'
          ? composeCustomPositive(
              {
                prompt,
                nl,
                fixed: fixedPositive,
                characters,
                characterTag: presentArchive.text,
                seed: input.seed,
                width: pixels?.width ?? 0,
                height: pixels?.height ?? 0,
              },
              customLayered,
            )
          : prompt;
      /**
       * 负面:**custom 模式也得把固定负面带上**。
       *
       * 以前这里直接 `negative_prompt: input.negative`,也就是只发 AI 给这张图编的
       * 「本图排除词」,用户在「提示词」框里写的通用负面(lowres / bad anatomy …)
       * 整段发不出去,%negative_prompt% 只拿到半份,负面当然没效果。
       */
      const customNegative =
        conn.mode === 'custom'
          ? composeCustomNegative({ negative: input.negative, fixed: fixedNegative }, customLayered)
          : (input.negative ?? '');
      result = await generateComfyImage(
        conn,
        {
          prompt: customPrompt,
          nl,
          negative_prompt: customNegative,
          seed: input.seed,
          size,
          // 显式交出像素:自定义工作流里的 %width%/%height% 全靠它,
          // 留空会让占位符被替换成 0,ComfyUI 的 EmptyLatentImage 立刻 400
          width: pixels?.width ?? 0,
          height: pixels?.height ?? 0,
          // 只有分层开启时才把角色层交给后端;关掉就回到 0.5.0 旧口径(角色不进 CLIP)
          characters: comfyLayered ? characters : undefined,
          characterTag: comfyLayered ? presentArchive.text : undefined,
        },
        signal,
        { onQueue: ahead => progress.onQueue?.(ahead) },
      );
      // ComfyUI 没有运行期跳过的概念，配方全在预设里，可在此直接快照。
      // 尺寸解析口径与 generateComfyImage 一致（未解析出时 0 = 用工作流自带尺寸）。
      const width = pixels?.width ?? 0;
      const height = pixels?.height ?? 0;
      const simpleValues: SimpleGenValues = {
        prompt,
        nl,
        negative: input.negative,
        characters: comfyLayered ? characters : undefined,
        characterTag: comfyLayered ? presentArchive.text : undefined,
        seed: input.seed,
        width,
        height,
      };
      meta = {
        backend: 'comfyui',
        model: status.model,
        width,
        height,
        // custom 模式记下实际塞进 %prompt% / %negative_prompt% 的那两串
        positive: conn.mode === 'simple' ? composePositive(conn.simple, simpleValues) : customPrompt,
        negative: conn.mode === 'simple' ? composeNegative(conn.simple, simpleValues) : customNegative,
        artist: null,
        vibes: [],
        params: conn.mode === 'simple' ? comfySimpleParams(conn.simple) : { mode: 'custom' },
      };
    }

    // 退避文案到此为止:图已拿到,落盘还要一会儿,不该继续显示「稍后重试」
    progress.onRetry?.(null);
    return {
      result,
      seed: input.seed,
      size,
      backend: status.backend,
      charactersApplied,
      meta,
      // 这次实际追加的角色档案串(灯箱与图库要能回溯「这张图为什么多了这几个词」)
      characterPrompt: presentArchive.text,
    };
  } finally {
    release?.();
  }
}
