/**
 * CDP 传输层：一条浏览器级 WebSocket，多路复用多个扁平会话。
 *
 * 为什么用浏览器级端点而不是每个页面开一条 WebSocket：
 * 浏览器级端点上的 `Target.attachToTarget({flatten:true})` 会返回一个 sessionId，
 * 之后所有命令靠 `sessionId` 字段路由到具体页面。一条连接就能同时管多个标签页，
 * 页面被关掉时也不会留下悬空的 socket。
 *
 * 运行时依赖：全局 WebSocket（Node 22+ 内置，无需 ws 依赖）。
 * 本文件不 import 任何 DSH 包，可以脱离宿主单独测试。
 */

/** 一次命令调用的默认超时。CDP 命令本身不设超时，卡住必须由我们暴露。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

/**
 * CDP 命令失败。保留原始 code 与 data：调用方需要靠 code 区分
 * "元素真的不存在"（`-32000`）与"协议用错了"（`-32601`）这类情况。
 */
export class CdpError extends Error {
  /**
   * @param {string} method
   * @param {{ code?: number, message?: string, data?: string }} error
   */
  constructor(method, error) {
    super(
      `CDP ${method} 失败：${error?.message ?? '未知错误'}${error?.code === undefined ? '' : `（code ${error.code}）`}`,
    );
    this.name = 'CdpError';
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

/** 会话/连接已失效。调用方据此决定"重连"还是"报错"。 */
export class CdpClosedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CdpClosedError';
  }
}

/**
 * 解析一条 CDP 文本帧。
 *
 * 输入的来源是不可信进程，因此形状必须在这里固定下来：解析失败返回 null，
 * 由调用方决定是忽略还是报错，绝不让畸形帧把监听器打崩。
 *
 * @param {unknown} raw
 * @returns {CdpFrame | null}
 */
export function parseFrame(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.method === 'string') {
    return {
      kind: 'event',
      method: value.method,
      params: value.params ?? {},
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    };
  }
  if (typeof value.id === 'number') {
    return {
      kind: 'response',
      id: value.id,
      result: value.result,
      error: value.error,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    };
  }
  return null;
}

/**
 * 一条浏览器级 CDP 连接。
 */
export class CdpConnection {
  /**
   * @param {WebSocket} socket 已打开的 WebSocket
   * @param {{ commandTimeoutMs?: number }} [options]
   */
  constructor(socket, options = {}) {
    this.socket = socket;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    /** @type {number} */
    this.nextId = 0;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, method: string, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** @type {Set<(event: CdpEvent) => void>} */
    this.listeners = new Set();
    /** @type {string | null} */
    this.closedReason = null;

    socket.addEventListener('message', (event) => {
      const frame = parseFrame(typeof event.data === 'string' ? event.data : String(event.data));
      if (frame === null) return;
      if (frame.kind === 'response') this.#settle(frame);
      else this.#emit(frame);
    });
    const onClose = () => this.#failAll(new CdpClosedError('CDP 连接已关闭。'));
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', () => {
      /* 具体错误由 close 事件统一暴露，避免同一次失败报两遍。 */
    });
  }

  /**
   * 打开一条连接。
   *
   * @param {string} url 形如 `ws://127.0.0.1:24000/devtools/browser/<id>`
   * @param {{ commandTimeoutMs?: number, openTimeoutMs?: number }} [options]
   * @returns {Promise<CdpConnection>}
   */
  static async open(url, options = {}) {
    const openTimeoutMs = options.openTimeoutMs ?? 10000;
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CdpClosedError(`连接 CDP 端点超时（${openTimeoutMs}ms）：${url}`));
      }, openTimeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new CdpClosedError(`无法连接 CDP 端点：${url}`));
        },
        { once: true },
      );
    });
    return new CdpConnection(socket, options);
  }

  /**
   * 发一条命令。
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ sessionId?: string, timeoutMs?: number }} [options]
   * @returns {Promise<any>} CDP 返回的 result 字段
   */
  send(method, params = {}, options = {}) {
    if (this.closedReason !== null) return Promise.reject(new CdpClosedError('CDP 连接已关闭。'));
    const id = ++this.nextId;
    const payload = /** @type {Record<string, unknown>} */ ({ id, method, params });
    if (options.sessionId !== undefined) payload.sessionId = options.sessionId;
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, { message: `命令在 ${timeoutMs}ms 内没有返回` }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new CdpClosedError(
            `发送 ${method} 失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  /**
   * 订阅事件。返回退订函数。
   *
   * @param {(event: CdpEvent) => void} listener
   * @returns {() => void}
   */
  on(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 关闭连接。幂等。 */
  close() {
    this.#failAll(new CdpClosedError('CDP 连接已由插件关闭。'));
    try {
      this.socket.close();
    } catch {
      /* 已经关了就无所谓。 */
    }
  }

  /** @param {CdpResponseFrame} frame */
  #settle(frame) {
    const entry = this.pending.get(frame.id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(frame.id);
    if (frame.error !== undefined) entry.reject(new CdpError(entry.method, frame.error));
    else entry.resolve(frame.result);
  }

  /** @param {CdpEventFrame} frame */
  #emit(frame) {
    const event = /** @type {CdpEvent} */ ({
      method: frame.method,
      params: frame.params,
      sessionId: frame.sessionId,
    });
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* 一个订阅者抛异常不该影响其他订阅者，也不该打断 CDP 循环。 */
      }
    }
  }

  /** @param {Error} reason */
  #failAll(reason) {
    if (this.closedReason === null) this.closedReason = reason.message;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this.pending.delete(id);
    }
  }
}

/**
 * @typedef {object} CdpEvent
 * @property {string} method
 * @property {Record<string, any>} params
 * @property {string | undefined} sessionId
 */

/**
 * @typedef {object} CdpEventFrame
 * @property {'event'} kind
 * @property {string} method
 * @property {Record<string, any>} params
 * @property {string | undefined} sessionId
 */

/**
 * @typedef {object} CdpResponseFrame
 * @property {'response'} kind
 * @property {number} id
 * @property {any} result
 * @property {{ code?: number, message?: string, data?: string } | undefined} error
 * @property {string | undefined} sessionId
 */

/** @typedef {CdpEventFrame | CdpResponseFrame} CdpFrame */
