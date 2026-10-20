/**
 * 端口挑选与 CDP 端点探测。
 *
 * 这一层刻意保持纯逻辑：只依赖 node:net 与全局 fetch，可以被单独测试，
 * 也可以在宿主之外运行。端口不是"猜一个没被占用的数字"，而是两级证据：
 *
 *   1. 绑定探测——能不能在回环地址上真正 listen。这是唯一可靠的"空闲"证据。
 *   2. 端点探测——listen 之后能不能在 /json/version 上问到 DevTools 协议版本。
 *
 * 为什么两级都要：端口空闲不等于端口上跑着我们想要的浏览器。可能有别的进程
 * 刚好也 listen 在这个端口上（甚至是一个旧的无头实例残留），只做绑定探测会
 * 让我们连上一个身份不明的调试端点。
 */

import { createServer } from 'node:net';

/** 默认端口范围。刻意避开 9222（他人常用）、3000/5173/8000（开发服务）等段。 */
export const DEFAULT_PORT_RANGE = /** @type {const} */ ([24000, 24060]);

/** CDP HTTP 端点的探测路径。 */
export const VERSION_PATH = '/json/version';

/**
 * 解析端口范围配置。
 *
 * 接受 `[lo, hi]`、`"lo-hi"` 或 `"lo"`（单端口）。非法输入不抛异常，
 * 而是回退到默认范围并给出原因——配置错误不该让插件无法激活。
 *
 * @param {unknown} value 用户配置
 * @returns {{ range: [number, number], problem: string | null }}
 */
export function parsePortRange(value) {
  const fallback = /** @type {[number, number]} */ ([...DEFAULT_PORT_RANGE]);
  if (value === undefined || value === null) return { range: fallback, problem: null };

  /** @type {unknown[]} */
  let parts;
  if (Array.isArray(value)) parts = value;
  else if (typeof value === 'string') parts = value.split('-');
  else if (typeof value === 'number') parts = [value];
  else
    return {
      range: fallback,
      problem: `portRange 的类型 ${typeof value} 不受支持，已回退到默认范围。`,
    };

  const numbers = parts.map((part) => (typeof part === 'string' ? Number(part.trim()) : part));
  if (numbers.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535)) {
    return {
      range: fallback,
      problem: `portRange 含非法端口（${JSON.stringify(value)}），已回退到默认范围。`,
    };
  }

  const lo = /** @type {number} */ (numbers[0]);
  const hi = numbers.length > 1 ? /** @type {number} */ (numbers[1]) : lo;
  if (hi < lo) return { range: fallback, problem: `portRange 的上界小于下界，已回退到默认范围。` };
  return { range: [lo, hi], problem: null };
}

/**
 * 展开端口范围，并优先尝试一个偏好端口（例如上一次用过的端口，避免端口漂移）。
 *
 * @param {[number, number]} range
 * @param {number | undefined} preferred
 * @returns {number[]}
 */
export function candidatePorts(range, preferred) {
  const [lo, hi] = range;
  /** @type {number[]} */
  const ports = [];
  const reuse =
    typeof preferred === 'number' &&
    Number.isInteger(preferred) &&
    preferred >= lo &&
    preferred <= hi;
  if (reuse) ports.push(/** @type {number} */ (preferred));
  for (let port = lo; port <= hi; port += 1) {
    if (reuse && port === preferred) continue;
    ports.push(port);
  }
  return ports;
}

/**
 * 端口是否可以在回环地址上被绑定。
 *
 * 用 listen 而不是 connect 来判断：一个处于 TIME_WAIT 或已被他人 listen 的端口
 * 都应该被跳过，而带独占选项的 listen 是唯一能同时覆盖这两种情况的证据。
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 问一次 DevTools 端点，返回版本信息。
 *
 * @param {number} port
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: true, version: CdpVersion } | { ok: false, reason: string }>}
 */
export async function probeCdpEndpoint(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000;
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`http://127.0.0.1:${port}${VERSION_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body = await response.json();
    if (typeof body?.webSocketDebuggerUrl !== 'string') {
      return { ok: false, reason: '响应里没有 webSocketDebuggerUrl，可能不是 DevTools 端点' };
    }
    return { ok: true, version: normaliseVersion(body) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 规范化 /json/version 的响应。
 *
 * 不信任字段名与类型：这是来自另一个进程的输入，尤其是端口被别的程序占用时，
 * 拿到的可能完全是别的东西。
 *
 * @param {any} body
 * @returns {CdpVersion}
 */
export function normaliseVersion(body) {
  return {
    browser: typeof body?.Browser === 'string' ? body.Browser : 'unknown',
    protocolVersion:
      typeof body?.['Protocol-Version'] === 'string' ? body['Protocol-Version'] : 'unknown',
    webSocketDebuggerUrl: String(body.webSocketDebuggerUrl),
    userAgent: typeof body?.['User-Agent'] === 'string' ? body['User-Agent'] : '',
  };
}

/**
 * 等 DevTools 端点就绪。
 *
 * 浏览器进程启动到端点可用之间有一段真实延迟（冷启动可能一两秒），
 * 因此这里是轮询 + 总超时，而不是 sleep 一个魔法数字。
 *
 * @param {number} port
 * @param {{ timeoutMs?: number, intervalMs?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<{ ok: true, version: CdpVersion, waitedMs: number } | { ok: false, reason: string, waitedMs: number }>}
 */
export async function waitForCdpEndpoint(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const intervalMs = options.intervalMs ?? 200;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  let lastReason = '未探测';

  while (Date.now() - started < timeoutMs) {
    const probe = await probeCdpEndpoint(port, { fetchImpl: options.fetchImpl, timeoutMs: 1000 });
    if (probe.ok) return { ok: true, version: probe.version, waitedMs: Date.now() - started };
    lastReason = probe.reason;
    await sleep(intervalMs);
  }
  return { ok: false, reason: lastReason, waitedMs: Date.now() - started };
}

/**
 * 选出第一个真正可用的端口，并确认它上面跑着 DevTools 端点。
 *
 * @param {object} options
 * @param {[number, number]} options.range
 * @param {number} [options.preferred] 优先尝试的端口
 * @param {(port: number) => Promise<boolean>} [options.isFree] 注入点，便于测试
 * @param {(port: number) => Promise<boolean>} [options.hasEndpoint] 注入点，便于测试
 * @param {number} [options.maxProbes] 最多检查多少个候选，避免大范围下扫太久
 * @returns {Promise<{ port: number, skipped: number, reason: string | null }>}
 */
export async function selectFreePort(options) {
  const isFree = options.isFree ?? isPortFree;
  const hasEndpoint = options.hasEndpoint ?? (async (port) => (await probeCdpEndpoint(port)).ok);
  const candidates = candidatePorts(options.range, options.preferred);
  const limit = Math.min(candidates.length, options.maxProbes ?? 64);

  for (let index = 0; index < limit; index += 1) {
    const port = /** @type {number} */ (candidates[index]);
    // 已经有 DevTools 端点 ⇒ 端口被别人（很可能是残留的旧实例）占了，跳过。
    if (await hasEndpoint(port)) continue;
    if (await isFree(port)) return { port, skipped: index, reason: null };
  }
  return {
    port: 0,
    skipped: limit,
    reason: `在 ${options.range[0]}-${options.range[1]} 范围内试了 ${limit} 个端口，没有一个既能绑定又没有占用。`,
  };
}

/**
 * @typedef {object} CdpVersion
 * @property {string} browser 形如 `Chrome/155.0.8059.40`
 * @property {string} protocolVersion 形如 `1.3`
 * @property {string} webSocketDebuggerUrl 浏览器级 WebSocket 端点
 * @property {string} userAgent
 */
