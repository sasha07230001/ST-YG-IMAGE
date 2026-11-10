/**
 * 中转站客户端:把一段剧情正文编译成 CLIP 提示词的那一次模型调用。
 *
 * ## 与YG原有链路的关系
 *
 * YG原本是用 ST 自己的 generateRaw / 副 API 请求一次,让模型输出
 * 「位置 ID + tag + nl」的结构化 JSON。本模块是**另一条提示词通道**:
 * 输入一段正文,输出一行可直接写进 ComfyUI CLIPTextEncode 的英文提示词。
 *
 * 两条通道共用同一个 ST 服务端代理端点(`/api/backends/chat-completions/generate`),
 * 但请求体刻意不走 `buildRequestBody`:那条路会带上 tool_choice / presence_penalty
 * 之类为"JSON 协议"准备的字段,而这里要的是**一次纯补全**。
 *
 * 关键设计——**请求走 SillyTavern 服务端代理**:
 * 1. 没有 CORS 问题——任何 OpenAI 兼容中转站(哪怕没开跨域)都能用;
 * 2. key 只经 ST 服务端转发,不暴露给页面上别的脚本。
 */

import { getContext } from '@/st/context';
import { RelayError } from '@/relay/errors';
import {
  injectPurge,
  stripPrefill,
  withPrefill,
  type PurgeSettings,
} from '@/relay/purge';
import { alternateRelayUrl, normalizeRelayUrl } from '@/relay/prompt';

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface RelayConn {
  url: string;
  key: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutSec?: number;
  /** purge 层设置;不给就是原样发送。 */
  purge?: PurgeSettings;
}

const GENERATE_URL = '/api/backends/chat-completions/generate';
const STATUS_URL = '/api/backends/chat-completions/status';
const DEFAULT_TIMEOUT_SEC = 120;

/** 超时包装器:把整个请求(建连 + 读完 body)一起算进时限。 */
async function withTimeout<T>(
  timeoutSec: number,
  external: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  const sec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : DEFAULT_TIMEOUT_SEC;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, sec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (error) {
    if (timedOut) throw new RelayError(`${label}超时(>${sec}秒)`);
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 对消息列表套上 purge 层:system 前面压权威声明 + assistant prefill 起头。
 *
 * 单槽重写、分段编译、正文分析三种请求都走这里,不各套一份——
 * 一处漏掉就是那一类请求悄悄没了反降级。
 */
export function applyPurge(
  purge: PurgeSettings | undefined,
  messages: ChatMsg[],
): { messages: ChatMsg[]; prefillText: string } {
  if (!purge?.enabled) return { messages, prefillText: '' };

  let out: ChatMsg[] = messages;
  if (purge.injectSystem) {
    const text = String(purge.systemPrompt ?? '').trim();
    if (text) {
      const first = out[0];
      if (first && first.role === 'system') {
        out = [{ role: 'system', content: injectPurge(first.content, text) }, ...out.slice(1)];
      } else {
        out = [{ role: 'system', content: text }, ...out];
      }
    }
  }

  const prefillText = String(purge.prefillText ?? '').trim();
  if (purge.prefill && prefillText) {
    return { messages: withPrefill(out, prefillText) as ChatMsg[], prefillText };
  }
  return { messages: out, prefillText: '' };
}

/**
 * 组装 ST 代理的请求体。
 * 刻意非流式:出图这一跳要的是「一次给完的完整 tag」,流式只增加拼接出错的面。
 * 也刻意不发 tools——tag 必须直接输出,不能被工具调用拐走。
 */
export function buildRelayBody(
  conn: RelayConn,
  messages: ChatMsg[],
  base: string,
): Record<string, unknown> {
  return {
    chat_completion_source: 'openai',
    reverse_proxy: base,
    proxy_password: conn.key || '',
    model: conn.model,
    messages,
    temperature: Number.isFinite(conn.temperature) ? conn.temperature : 0.8,
    // 结构化 JSON(每张图的 tag/nl + changes 建档 + transient 穿戴)动辄上千 token:
    // 400 会在建档那一轮把 JSON 截断在右括号之前,解析必然失败,一整次请求连同重试全白烧。
    max_tokens: Number.isFinite(conn.maxTokens) ? conn.maxTokens : 4000,
    stream: false,
    tool_choice: 'none',
    presence_penalty: 0,
    frequency_penalty: 0,
  };
}

/** 把 string / content-parts 数组 / 其它类型统一成文本。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') out += text;
      }
    }
    return out;
  }
  return '';
}

/**
 * 从响应体提取答案。标准链之外还要看 reasoning 一族:
 * 推理模型(deepseek-reasoner 等)有时把全部内容塞进 reasoning_content 而 content 为空。
 */
export function extractRelayContent(data: unknown): string {
  const d = data as Record<string, any> | null | undefined;
  const msg = d?.choices?.[0]?.message;
  const content = textOf(msg?.content) || textOf(d?.choices?.[0]?.text) || textOf(d?.content);
  if (String(content ?? '').trim()) return String(content).trim();
  return (
    textOf(msg?.reasoning) || textOf(msg?.reasoning_content) || textOf(msg?.thinking)
  ).trim();
}

export interface RelayOptions {
  signal?: AbortSignal;
  /** 只有首个地址明确返回 404/405 时才换备用形式(/v1)重试一次。 */
  allowUrlFallback?: boolean;
  /**
   * 拿到文本后的验收钩子:与主 API / 副 API 两条链同一个契约(抛错 = 这次不算数)。
   * 结构化协议下这里传 parseImagePlan 的包装;留空则不验收(连通性测试用)。
   */
  validate?: (content: string) => void;
}

/** 发一次补全,返回原始文本。 */
async function callOnce(
  conn: RelayConn,
  messages: ChatMsg[],
  base: string,
  opts: RelayOptions,
  prefill?: { text: string },
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new RelayError('SillyTavern 上下文不可用');
  const body = buildRelayBody(conn, messages, base);
  const timeoutSec = conn.timeoutSec ?? DEFAULT_TIMEOUT_SEC;

  return withTimeout(timeoutSec, opts.signal, '中转站请求', async signal => {
    const resp = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new RelayError(
        `中转站请求失败 (${resp.status})${text ? `：${text.slice(0, 300)}` : ''}`,
        resp.status,
      );
    }
    const data = await resp.json().catch(() => null);
    const err = (data as Record<string, any> | null)?.error;
    if (err) throw new RelayError(typeof err === 'string' ? err : err.message || '中转站返回错误');
    const content = extractRelayContent(data);
    if (!content) throw new RelayError('中转站返回了空内容');
    // 端点把 prefill 原样回显时,削掉开头的 POSITIVE: 之类,否则会污染 tag
    return prefill?.text ? stripPrefill(content, prefill.text) : content;
  });
}

/**
 * 端点不认 assistant prefill 时的识别:
 * - 422:大多数中转站直接拒;
 * - 400 里带 assistant / prefill / last message 的更明确。
 * 这类错误重试无意义,直接去掉 prefill 再发一次。
 */
function looksLikePrefillRejection(error: unknown): boolean {
  if (!(error instanceof RelayError)) return false;
  const text = error.message.toLowerCase();
  if (error.status === 422) return true;
  if (error.status !== 400) return false;
  return /assistant|prefill|last message|role|messages\[/i.test(text) || text.length < 40;
}

/**
 * 让中转站把剧情编译成 CLIP 提示词。失败抛 RelayError(人话),调用方负责 toast/重试。
 * 返回值已剥掉代码块/前缀并验过「像英文提示词」,但**还没**加恒定画风词。
 */
export async function compilePrompt(
  conn: RelayConn,
  messages: ChatMsg[],
  opts: RelayOptions = {},
): Promise<string> {
  if (!String(conn.url ?? '').trim()) throw new RelayError('请先填写中转站 API 地址');
  if (!String(conn.model ?? '').trim()) throw new RelayError('请先填写中转站模型名');

  const base = normalizeRelayUrl(conn.url);
  const purged = applyPurge(conn.purge, messages);
  const prefill = purged.prefillText ? { text: purged.prefillText } : undefined;

  const send = async (targetBase: string): Promise<string> => {
    try {
      return await callOnce(conn, purged.messages, targetBase, opts, prefill);
    } catch (error) {
      if (!prefill || !looksLikePrefillRejection(error)) throw error;
      console.info('[YG·插图] 该端点不接受 assistant prefill,本次改为普通请求');
      const withoutPrefill = purged.messages.filter(
        m => !(m.role === 'assistant' && m.content === prefill.text),
      );
      return callOnce(conn, withoutPrefill as ChatMsg[], targetBase, opts);
    }
  };

  // 0.7 起中转站也走同一份结构化协议(images/changes/transient 的 JSON)。这里不再按
  // 「一行英文 tag」验收 —— 那套判据会把合法 JSON 判成不合格(JSON 里中文角色名一多就
  // 触发「提示词以中文为主」)。验收统一交给调用方传进来的 validate(即 parseImagePlan),
  // 与主 API / 副 API 两条链逐字同源。
  const accept = (raw: string): string => {
    const text = raw.trim();
    if (!text) throw new RelayError('中转站返回了空内容');
    opts.validate?.(text);
    return text;
  };

  try {
    return accept(await send(base));
  } catch (error) {
    const status = error instanceof RelayError ? error.status : undefined;
    if (!opts.allowUrlFallback || (status !== 404 && status !== 405)) throw error;
    const fallback = alternateRelayUrl(base);
    if (!fallback || fallback === base) throw error;
    return accept(await send(fallback));
  }
}

/** 连通性测试:发一句极短的话,确认 url/key/model 三者都对。 */
export async function testRelayConnection(
  conn: RelayConn,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  try {
    const base = normalizeRelayUrl(conn.url);
    const reply = await callOnce(conn, [{ role: 'user', content: '只回复两个字:正常' }], base, {
      signal,
      allowUrlFallback: false,
    });
    return { ok: true, message: `连通正常,返回:${reply.slice(0, 40)}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 拉模型列表(走 ST 的 /status 代理,标准 /v1/models)。只需 url + key。 */
export async function fetchRelayModels(
  conn: Pick<RelayConn, 'url' | 'key' | 'timeoutSec'>,
): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new RelayError('SillyTavern 上下文不可用');
  if (!String(conn.url ?? '').trim()) throw new RelayError('请先填写 API 地址');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeRelayUrl(conn.url),
    proxy_password: conn.key || '',
  };

  return withTimeout(conn.timeoutSec ?? 60, undefined, '拉取模型', async signal => {
    const resp = await fetch(STATUS_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new RelayError(
        `拉取模型失败 (${resp.status})${text ? `：${text.slice(0, 200)}` : ''}`,
        resp.status,
      );
    }
    const data = (await resp.json().catch(() => null)) as Record<string, any> | null;
    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}
