/**
 * 受管浏览器上的页面操作语义。
 *
 * 这是插件的心脏：把 CDP 的原始命令翻译成"智能体能用的动作"——导航、读可交互元素、
 * 真实点击、真实输入、等待、截图、看网络与控制台。
 *
 * 两条贯穿全文件的原则：
 *
 * 1. **不猜。** 引用号（ref）来自真实 DOM 快照，点击位置来自真实几何信息。
 *    引用失效时明确要求重新快照，绝不"差不多就点这里"。
 * 2. **动作后必有回读。** 每次操作都返回动作后的页面状态（URL、标题、正文摘要、
 *    以及最近的控制台/网络异常），让智能体一步就能判断"成了没有"，
 *    而不是被迫再发一轮工具调用去确认。
 *
 * 本文件不 import 任何 DSH 包，可以脱离宿主用真实浏览器测试。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CdpConnection, CdpError, CdpClosedError } from './cdp.js';
import { launchBrowser } from './chromium.js';

/** 单次 fast 命令的超时（不含导航与等待）。 */
const FAST_TIMEOUT_MS = 15000;

/** 导航与显式等待默认给更长的预算：真实站点就是会慢。 */
const NAVIGATION_TIMEOUT_MS = 30000;

/** 快照元素数量上限。超过就截断并如实说明，而不是把上下文灌满。 */
export const MAX_SNAPSHOT_ELEMENTS = 150;

/** 单个元素文本的展示长度上限。 */
export const MAX_ELEMENT_TEXT = 160;

/** 正文读取的默认上限（按字符）。 */
export const DEFAULT_CONTENT_LIMIT = 20000;

/** 网络与控制台环缓冲的容量。 */
export const EVENT_BUFFER_SIZE = 300;

/** 元素标记属性名。用插件自带前缀，避免与页面自身属性冲突。 */
export const REF_ATTRIBUTE = 'data-dsh-browser-ref';

/** 在页面里执行的快照脚本。返回可交互元素清单（含视口内中心坐标）。 */
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const ATTR = ${JSON.stringify(REF_ATTRIBUTE)};
  const MAX = ${MAX_SNAPSHOT_ELEMENTS};
  const MAX_TEXT = ${MAX_ELEMENT_TEXT};
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select',
    'summary', '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]',
    '[role=tab]', '[role=menuitem]', '[role=option]', '[role=switch]',
    '[contenteditable=true]', '[contenteditable=""]', '[onclick]', '[tabindex]'
  ].join(',');

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const label = (el) => {
    let text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim();
    text = text.replace(/\s+/g, ' ');
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '…';
    return text;
  };
  const state = (el) => {
    const out = {};
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
    if (el.checked !== undefined && el.type !== undefined && el.type !== 'hidden') out.checked = !!el.checked;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const type = el.getAttribute('type');
      if (type) out.type = type;
    }
    if (el.tagName === 'SELECT') {
      const option = el.selectedOptions && el.selectedOptions[0];
      if (option) out.selected = (option.textContent || '').trim().slice(0, MAX_TEXT);
    }
    return out;
  };

  let index = 0;
  const items = [];
  let truncated = false;
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (!visible(el)) continue;
    if (index >= MAX) { truncated = true; break; }
    const ref = 'e' + (++index);
    el.setAttribute(ATTR, ref);
    const rect = el.getBoundingClientRect();
    const item = {
      ref,
      tag: el.tagName.toLowerCase(),
      text: label(el),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      inViewport: rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0,
      state: state(el)
    };
    const role = el.getAttribute('role');
    if (role) item.role = role;
    if (el.id) item.id = el.id;
    const name = el.getAttribute('name');
    if (name) item.name = name;
    const href = el.getAttribute('href');
    if (href) item.href = href.slice(0, 200);
    items.push(item);
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    scrollY: Math.round(scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    viewport: { width: innerWidth, height: innerHeight },
    total: items.length,
    truncated,
    items
  };
})()`;

/** 页面状态摘要脚本。动作后回读用，故意很轻。 */
export const PAGE_STATE_SCRIPT = String.raw`(() => ({
  url: location.href,
  title: document.title,
  readyState: document.readyState,
  text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 400)
}))()`;

/**
 * 一个受管浏览器实例：进程 + CDP 连接 + 当前页面。
 */
export class ManagedBrowser {
  /**
   * @param {object} options
   * @param {any} options.config 已解析的插件配置
   * @param {string} options.dataDir 插件数据目录
   * @param {(message: string) => void} [options.warn]
   */
  constructor(options) {
    this.config = options.config;
    this.dataDir = options.dataDir;
    this.warn = options.warn ?? (() => {});
    /** @type {import('./chromium.js').BrowserProcess | null} */
    this.process = null;
    /** @type {CdpConnection | null} */
    this.connection = null;
    /** @type {import('./ports.js').CdpVersion | null} */
    this.version = null;
    /** @type {number | null} */
    this.port = null;
    /** @type {string | null} */
    this.product = null;
    /** @type {boolean} */
    this.sandboxDisabled = false;
    /** @type {string | null} */
    this.currentTargetId = null;
    /** @type {string | null} */
    this.currentSessionId = null;
    /** @type {Map<string, { ref: string, tag: string, text: string, seenAt: number }>} */
    this.refs = new Map();
    /**
     * 已 attach 的标签。**不能叫 `this.tabs`**：那会遮蔽原型上的 `tabs()` 方法，
     * 让 `browser.tabs(...)` 变成"Map 不是函数"。这是实测踩到的坑。
     * @type {Map<string, { targetId: string, sessionId: string, url: string, title: string }>}
     */
    this.openTabs = new Map();
    /** @type {NetworkEntry[]} */
    this.network = [];
    /** @type {ConsoleEntry[]} */
    this.console = [];
    /** @type {Map<string, NetworkEntry>} */
    this.networkByRequestId = new Map();
    /** @type {(() => void)[]} */
    this.eventDisposers = [];
    /** @type {Promise<any>} */
    this.queue = Promise.resolve();
    /** @type {Set<string>} */
    this.pendingRequests = new Set();
  }

  /** 是否已经连接上一个活着的浏览器。 */
  get running() {
    return this.process !== null && this.process.alive && this.connection !== null;
  }

  /** 给人看的简短状态。 */
  get statusLine() {
    if (this.running) return `运行中 · 端口 ${this.port} · ${this.openTabs.size} 个标签`;
    if (this.process !== null && !this.process.alive)
      return `已退出（${this.process.processState}）`;
    return '未启动';
  }

  /**
   * 保证浏览器可用：需要时启动、连接、打开一个页面。
   *
   * @param {{ url?: string, headless?: boolean, width?: number, height?: number, timeoutMs?: number }} [options]
   * @returns {Promise<BrowserOpenReport>}
   */
  async ensure(options = {}) {
    if (this.running) {
      const page =
        options.url === undefined
          ? await this.currentPageReport()
          : await this.navigate(options.url, { timeoutMs: options.timeoutMs });
      return { ...this.#connectionReport(), reused: true, page };
    }
    await this.#shutdownInternal();
    const launched = await launchBrowser({
      config: this.config,
      dataDir: this.dataDir,
      preferredPort: this.port === null ? undefined : this.port,
      headless: options.headless === undefined ? undefined : options.headless === true,
      warn: this.warn,
      initialUrl: 'about:blank',
    });
    if (!launched.ok) {
      const error = new Error([launched.error, ...launched.detail].join('\n'));
      error.name = 'BrowserLaunchError';
      throw error;
    }
    this.process = launched.process;
    this.port = launched.port;
    this.version = launched.version;
    this.product = launched.product;
    this.sandboxDisabled = launched.sandboxDisabled;

    try {
      this.connection = await CdpConnection.open(launched.version.webSocketDebuggerUrl);
    } catch (error) {
      await this.#shutdownInternal();
      throw error;
    }
    this.#subscribeEvents();
    await this.connection.send('Target.setDiscoverTargets', { discover: true });
    await this.#attachNewestPage();

    const page =
      options.url === undefined
        ? await this.currentPageReport()
        : await this.navigate(options.url, { timeoutMs: options.timeoutMs });
    return { ...this.#connectionReport(), reused: false, page };
  }

  /**
   * 导航当前页面并等到可交互。
   *
   * @param {string} url
   * @param {{ timeoutMs?: number, waitUntil?: 'domcontentloaded' | 'load' | 'none' }} [options]
   * @returns {Promise<PageState>}
   */
  async navigate(url, options = {}) {
    const sessionId = await this.#requireSession();
    const waitUntil = options.waitUntil ?? 'domcontentloaded';
    const timeoutMs = options.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
    const target = normaliseUrl(url);

    const loadPromise =
      waitUntil === 'none' ? Promise.resolve() : this.#waitForLoad(sessionId, waitUntil, timeoutMs);
    try {
      await this.#send(
        'Page.navigate',
        { url: target },
        { sessionId, timeoutMs: Math.min(timeoutMs, NAVIGATION_TIMEOUT_MS) },
      );
    } catch (error) {
      // net::ERR_* 这类导航失败必须原样暴露：站点不可达与工具坏掉是两件事。
      throw new Error(`导航到 ${target} 失败：${messageOf(error)}`);
    }
    await loadPromise;
    this.refs.clear();
    return this.currentPageReport();
  }

  /**
   * 读取可交互元素快照。
   *
   * @param {{ selector?: string, limit?: number }} [options]
   * @returns {Promise<Snapshot>}
   */
  async snapshot(options = {}) {
    const sessionId = await this.#requireSession();
    const raw = await this.#evaluate(SNAPSHOT_SCRIPT, { sessionId, returnByValue: true });
    if (raw === undefined || raw === null) throw new Error('页面快照执行失败：没有拿到结果。');
    /** @type {Snapshot} */
    const snapshot = raw;
    const limit = Math.min(options.limit ?? MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_ELEMENTS);
    if (options.selector !== undefined && options.selector !== '') {
      // 限定范围时重新在页面里取一次，避免把整页元素误当成"范围内的元素"。
      const scoped = await this.#evaluate(
        `(() => { const root = document.querySelector(${JSON.stringify(options.selector)}); return root ? root.querySelectorAll('*').length : 0; })()`,
        { sessionId, returnByValue: true },
      );
      snapshot.scopedCount = scoped;
    }
    snapshot.items = snapshot.items.slice(0, limit);
    this.refs.clear();
    const now = Date.now();
    for (const item of snapshot.items)
      this.refs.set(item.ref, { ref: item.ref, tag: item.tag, text: item.text, seenAt: now });
    return snapshot;
  }

  /**
   * 点击。定位方式三选一：ref（来自快照）、selector、坐标。
   *
   * @param {{ ref?: string, selector?: string, x?: number, y?: number, button?: 'left' | 'right' | 'middle', clickCount?: number }} target
   * @returns {Promise<ActionReport>}
   */
  async click(target) {
    const sessionId = await this.#requireSession();
    const resolved = await this.#resolvePoint(target, sessionId);
    const button = target.button ?? 'left';
    const clickCount = target.clickCount ?? 1;
    await this.#scrollIntoViewIfNeeded(resolved, sessionId);

    const base = {
      x: resolved.x,
      y: resolved.y,
      button,
      clickCount,
      buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4,
    };
    await this.#send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: base.x, y: base.y, buttons: 0 },
      { sessionId },
    );
    await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, { sessionId });
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, { sessionId });
    await this.#settle();
    return this.#actionReport('click', resolved, {
      scrolled: resolved.scrolled === true,
      button,
      clickCount,
    });
  }

  /**
   * 输入文本。默认用 Input.insertText：它走浏览器的文本输入路径，
   * 能正确处理中文等无法用单键事件表达的内容。
   *
   * @param {{ ref?: string, selector?: string, text: string, submit?: boolean, clear?: boolean, append?: boolean }} options
   * @returns {Promise<ActionReport>}
   */
  async type(options) {
    const sessionId = await this.#requireSession();
    const resolved = await this.#resolvePoint(options, sessionId);
    await this.#scrollIntoViewIfNeeded(resolved, sessionId);
    await this.#focus(resolved, sessionId);

    const clear = options.clear !== false && options.append !== true;
    if (clear) {
      // 用 JS 清空而不是模拟 30 次退格：对受控组件更可靠，也更快。
      await this.#evaluate(
        `(() => { const el = ${this.#queryExpression(options.ref, options.selector)}; if (!el) return false;
          if (el.isContentEditable) { el.textContent = ''; } else { el.value = ''; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true; })()`,
        { sessionId, returnByValue: true },
      );
    }
    if (options.text !== '') {
      await this.#send('Input.insertText', { text: options.text }, { sessionId });
    }
    if (options.submit === true) {
      await this.press({ key: 'Enter' });
    }
    await this.#settle();
    return this.#actionReport('type', resolved, {
      typed: options.text.length,
      cleared: clear,
      submitted: options.submit === true,
    });
  }

  /**
   * 发送按键。支持 Enter/Escape/Tab/方向键等具名键，以及 Cmd/Ctrl 组合。
   *
   * @param {{ key: string, modifiers?: string[] }} options
   * @returns {Promise<ActionReport>}
   */
  async press(options) {
    const sessionId = await this.#requireSession();
    const descriptor = describeKey(options.key, options.modifiers ?? []);
    /** @type {Record<string, unknown>} */
    const base = {
      modifiers: descriptor.modifiers,
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
    };
    if (descriptor.text !== undefined) base.text = descriptor.text;
    await this.#send(
      'Input.dispatchKeyEvent',
      { type: descriptor.text === undefined ? 'rawKeyDown' : 'keyDown', ...base },
      { sessionId },
    );
    await this.#send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, { sessionId });
    await this.#settle();
    return this.#actionReport(
      'key',
      {
        description: `${(options.modifiers ?? []).join('+')}${(options.modifiers ?? []).length > 0 ? '+' : ''}${options.key}`,
      },
      { modifiers: descriptor.modifiers },
    );
  }

  /**
   * 等待条件成立。条件三选一：selector、text、networkIdle。
   *
   * @param {{ selector?: string, text?: string, state?: 'visible' | 'detached', timeoutMs?: number, networkIdleMs?: number }} options
   * @returns {Promise<{ ok: boolean, waitedMs: number, condition: string, timedOut: boolean }>}
   */
  async wait(options) {
    const sessionId = await this.#requireSession();
    const timeoutMs = options.timeoutMs ?? 10000;
    const started = Date.now();
    const interval = 200;
    /** @type {string} */
    let condition;
    if (typeof options.selector === 'string' && options.selector !== '')
      condition = `selector ${options.selector}`;
    else if (typeof options.text === 'string' && options.text !== '')
      condition = `text ${JSON.stringify(options.text)}`;
    else condition = `network idle ${options.networkIdleMs ?? 500}ms`;

    while (Date.now() - started <= timeoutMs) {
      const satisfied = await this.#checkCondition(options, sessionId);
      if (satisfied)
        return { ok: true, waitedMs: Date.now() - started, condition, timedOut: false };
      await sleep(interval);
    }
    return { ok: false, waitedMs: Date.now() - started, condition, timedOut: true };
  }

  /**
   * 读取页面内容。
   *
   * @param {{ format?: 'text' | 'html', selector?: string, ref?: string, limit?: number }} [options]
   * @returns {Promise<{ url: string, title: string, format: string, scope: string, content: string, length: number, truncated: boolean }>}
   */
  async content(options = {}) {
    const sessionId = await this.#requireSession();
    const format = options.format ?? 'text';
    const limit = options.limit ?? DEFAULT_CONTENT_LIMIT;
    const scopeExpression =
      options.ref !== undefined && options.ref !== ''
        ? `document.querySelector('[${REF_ATTRIBUTE}="${options.ref}"]')`
        : options.selector !== undefined && options.selector !== ''
          ? `document.querySelector(${JSON.stringify(options.selector)})`
          : 'document.body';
    const expression =
      format === 'html'
        ? `(() => { const node = ${scopeExpression}; return node ? node.outerHTML : null; })()`
        : `(() => { const node = ${scopeExpression}; if (!node) return null;
             const raw = node.innerText !== undefined ? node.innerText : node.textContent;
             return (raw || '').replace(/\\n{3,}/g, '\\n\\n').trim(); })()`;
    const value = await this.#evaluate(expression, { sessionId, returnByValue: true });
    if (value === null || value === undefined) {
      throw new Error(
        `找不到要读取的范围：${options.ref ?? options.selector ?? 'document.body'}（页面可能已经变化，请重新 browser_snapshot）。`,
      );
    }
    const text = String(value);
    const truncated = text.length > limit;
    const page = await this.#pageState(sessionId);
    return {
      url: page.url,
      title: page.title,
      format,
      scope: options.ref ?? options.selector ?? 'body',
      content: truncated ? text.slice(0, limit) : text,
      length: text.length,
      truncated,
    };
  }

  /**
   * 读取一个元素的详细信息（属性、值、可见性）。
   *
   * @param {{ ref?: string, selector?: string }} target
   * @returns {Promise<{ found: boolean, element?: Record<string, unknown>, reason?: string }>}
   */
  async inspect(target) {
    const sessionId = await this.#requireSession();
    const query =
      target.ref !== undefined && target.ref !== ''
        ? `document.querySelector('[${REF_ATTRIBUTE}="${target.ref}"]')`
        : target.selector !== undefined && target.selector !== ''
          ? `document.querySelector(${JSON.stringify(target.selector)})`
          : 'null';
    const value = await this.#evaluate(
      `(() => { const el = ${query}; if (!el) return null;
         const rect = el.getBoundingClientRect();
         const style = getComputedStyle(el);
         const attributes = {};
         for (const attr of el.attributes) attributes[attr.name] = String(attr.value).slice(0, 200);
         return {
           tag: el.tagName.toLowerCase(),
           text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
           value: typeof el.value === 'string' ? el.value.slice(0, 500) : undefined,
           visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0,
           disabled: el.disabled === true,
           checked: typeof el.checked === 'boolean' ? el.checked : undefined,
           rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
           attributes
         }; })()`,
      { sessionId, returnByValue: true },
    );
    if (value === null || value === undefined) {
      return {
        found: false,
        reason: `在页面里找不到 ${target.ref ?? target.selector ?? '（未给出定位）'}；引用号会随页面变化失效，请重新 browser_snapshot。`,
      };
    }
    return { found: true, element: value };
  }

  /**
   * 截图落盘。
   *
   * 为什么必须落盘而不是把 base64 塞进工具结果：工具结果的展示内容只支持文本块
   * （见 docs/references/dsh-plugin-tools.md），而且几十 KB 的 base64 会把上下文灌爆。
   * 落盘后返回路径，人或 read_image 都能直接看。
   *
   * @param {{ fullPage?: boolean, ref?: string, selector?: string, format?: 'png' | 'jpeg', quality?: number }} [options]
   * @returns {Promise<{ path: string, bytes: number, width: number, height: number, fullPage: boolean }>}
   */
  async screenshot(options = {}) {
    const sessionId = await this.#requireSession();
    const format = options.format ?? 'png';
    /** @type {Record<string, unknown>} */
    const params = { format, captureBeyondViewport: options.fullPage === true };
    if (format === 'jpeg') params.quality = Math.max(1, Math.min(100, options.quality ?? 80));

    let clip;
    if (
      (options.ref !== undefined && options.ref !== '') ||
      (options.selector !== undefined && options.selector !== '')
    ) {
      // 先走一次定位解析：引用号失效、元素不可见这类情况在这里就会得到
      // 带下一步建议的错误，而不是让 CDP 抛一句难以理解的 clip 校验失败。
      const resolved = await this.#resolvePoint(options, sessionId);
      const box = await this.#evaluate(
        `(() => { const el = ${this.#queryExpression(resolved.ref, resolved.selector)}; if (!el) return null;
           const r = el.getBoundingClientRect();
           return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`,
        { sessionId, returnByValue: true },
      );
      if (box === null || box === undefined)
        throw new Error('要截图的范围已经不在页面里了，请重新 browser_snapshot。');
      clip = { ...box, scale: 1 };
      params.clip = clip;
    }

    const result = await this.#send('Page.captureScreenshot', params, {
      sessionId,
      timeoutMs: FAST_TIMEOUT_MS,
    });
    const data = typeof result?.data === 'string' ? result.data : '';
    if (data === '') throw new Error('截图失败：浏览器没有返回图像数据。');
    const buffer = Buffer.from(data, 'base64');
    const dir = join(this.dataDir, 'shots');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `shot-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`);
    writeFileSync(file, buffer);

    const metrics = clip ?? (await this.#viewportMetrics(sessionId));
    return {
      path: file,
      bytes: buffer.length,
      width: Math.round(metrics.width ?? 0),
      height: Math.round(metrics.height ?? 0),
      fullPage: options.fullPage === true,
    };
  }

  /**
   * 在页面里执行 JS。
   *
   * @param {string} expression
   * @param {{ awaitPromise?: boolean }} [options]
   * @returns {Promise<{ value: unknown, type: string, unserializable: boolean }>}
   */
  async evaluate(expression, options = {}) {
    const sessionId = await this.#requireSession();
    const result = await this.#send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise !== false,
        userGesture: true,
      },
      { sessionId, timeoutMs: NAVIGATION_TIMEOUT_MS },
    );
    if (result?.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails;
      const text = detail.exception?.description ?? detail.text ?? '未知异常';
      throw new Error(`页面里执行 JS 抛错：${String(text).split('\n')[0]}`);
    }
    const remote = result?.result ?? {};
    return {
      value: remote.value,
      type: typeof remote.type === 'string' ? remote.type : 'unknown',
      unserializable: remote.value === undefined && remote.type !== 'undefined',
    };
  }

  /**
   * 列出/新建/选中/关闭标签。
   *
   * @param {{ action?: 'list' | 'new' | 'select' | 'close', url?: string, targetId?: string }} [options]
   * @returns {Promise<{ action: string, tabs: TabInfo[], current?: string }>}
   */
  async tabs(options = {}) {
    const action = options.action ?? 'list';
    await this.#requireSession();
    if (action === 'new') {
      const created = await this.#send('Target.createTarget', {
        url: normaliseUrl(options.url ?? 'about:blank'),
      });
      await this.#attach(created.targetId, true);
    } else if (action === 'select') {
      const targetId = options.targetId ?? '';
      if (!this.openTabs.has(targetId))
        throw new Error(`没有这个标签：${targetId}。用 browser_tabs 列出当前标签。`);
      await this.#attach(targetId, true);
    } else if (action === 'close') {
      const targetId = options.targetId ?? this.currentTargetId ?? '';
      if (targetId === '') throw new Error('没有可关闭的标签。');
      await this.#send('Target.closeTarget', { targetId });
      this.openTabs.delete(targetId);
      if (this.currentTargetId === targetId) {
        this.currentTargetId = null;
        this.currentSessionId = null;
        await this.#attachNewestPage();
      }
    }
    return { action, tabs: await this.listTabs(), current: this.currentTargetId ?? undefined };
  }

  /**
   * 列出标签。
   *
   * @returns {Promise<TabInfo[]>}
   */
  async listTabs() {
    if (this.connection === null) return [];
    const result = await this.#send('Target.getTargets', {});
    const infos = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
    return infos
      .filter((/** @type {any} */ info) => info.type === 'page' || info.type === 'webview')
      .map((/** @type {any} */ info) => ({
        targetId: String(info.targetId),
        url: String(info.url ?? ''),
        title: String(info.title ?? ''),
        current: info.targetId === this.currentTargetId,
      }));
  }

  /**
   * 读取记录到的网络请求。
   *
   * @param {{ limit?: number, onlyFailures?: boolean, urlContains?: string }} [options]
   * @returns {{ entries: NetworkEntry[], dropped: number }}
   */
  readNetwork(options = {}) {
    let entries = this.network;
    if (options.onlyFailures === true) {
      entries = entries.filter(
        (entry) => entry.failed === true || (entry.status !== undefined && entry.status >= 400),
      );
    }
    if (typeof options.urlContains === 'string' && options.urlContains !== '') {
      const needle = options.urlContains;
      entries = entries.filter((entry) => entry.url.includes(needle));
    }
    const limit = options.limit ?? 50;
    return { entries: entries.slice(-limit), dropped: Math.max(0, entries.length - limit) };
  }

  /**
   * 读取控制台消息与页面异常。
   *
   * @param {{ limit?: number, onlyErrors?: boolean, clear?: boolean }} [options]
   * @returns {{ entries: ConsoleEntry[], dropped: number }}
   */
  readConsole(options = {}) {
    let entries = this.console;
    if (options.onlyErrors === true)
      entries = entries.filter((entry) => entry.level === 'error' || entry.level === 'warning');
    const limit = options.limit ?? 50;
    const result = { entries: entries.slice(-limit), dropped: Math.max(0, entries.length - limit) };
    if (options.clear === true) this.console = [];
    return result;
  }

  /**
   * 关闭浏览器并等待进程真的消失。
   *
   * @returns {Promise<{ closed: boolean, method: string, waitedMs: number }>}
   */
  async close() {
    const stopped =
      this.process === null
        ? { stopped: true, method: 'none', waitedMs: 0 }
        : await this.process.stop({});
    await this.#shutdownInternal();
    return { closed: stopped.stopped, method: stopped.method, waitedMs: stopped.waitedMs };
  }

  /** 断开连接但保留浏览器进程（插件卸载时用：进程不该随客户端消失）。 */
  async disconnect() {
    await this.#shutdownInternal({ keepProcess: true });
  }

  /**
   * 当前页面状态摘要。
   *
   * @returns {Promise<PageState>}
   */
  async currentPageReport() {
    try {
      const sessionId = await this.#requireSession();
      return await this.#pageState(sessionId);
    } catch (error) {
      return { url: '', title: '', readyState: 'unknown', text: '', error: messageOf(error) };
    }
  }

  /** 状态面板用的快照。 */
  panelStatus() {
    return {
      running: this.running,
      status: this.statusLine,
      port: this.port,
      browser: this.version?.browser ?? null,
      protocolVersion: this.version?.protocolVersion ?? null,
      product: this.product,
      sandboxDisabled: this.sandboxDisabled,
      profileDir: this.process?.userDataDir ?? null,
      executablePath: this.process?.executablePath ?? null,
      tabs: this.openTabs.size,
      currentUrl:
        [...this.openTabs.values()].find((tab) => tab.targetId === this.currentTargetId)?.url ??
        null,
      networkEntries: this.network.length,
      consoleEntries: this.console.length,
    };
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────────

  /**
   * 串行化所有页面操作。
   *
   * 为什么必须串行：CDP 命令本身是并发的，但"动作 + 回读"这一对如果交错，
   * 回读到的可能是另一个动作之后的状态，报告就会自相矛盾。工具调用本来就是
   * 顺序的，串行化的代价可以忽略。
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  #serial(task) {
    const next = this.queue.then(task, task);
    // 让队列在出错后继续可用：错误已经交给调用方，队列只需要吞掉拒绝。
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ sessionId?: string, timeoutMs?: number }} [options]
   */
  #send(method, params = {}, options = {}) {
    return this.#serial(async () => {
      const connection = this.connection;
      if (connection === null) throw new CdpClosedError('浏览器还没有启动。先调用 browser_open。');
      return connection.send(method, params, options);
    });
  }

  /**
   * 页面内取值。顺带做一次连接健康检查：连接断了要给"重开"的提示，
   * 而不是把 CDP 的英文错误原样丢给智能体。
   *
   * @param {string} expression
   * @param {{ sessionId: string, returnByValue?: boolean }} options
   */
  async #evaluate(expression, options) {
    try {
      const result = await this.#send(
        'Runtime.evaluate',
        { expression, returnByValue: options.returnByValue !== false, awaitPromise: true },
        { sessionId: options.sessionId, timeoutMs: FAST_TIMEOUT_MS },
      );
      return result?.result?.value;
    } catch (error) {
      throw new Error(this.#explain(error));
    }
  }

  /**
   * 把 CDP 错误翻译成能指导下一步动作的话。
   *
   * @param {unknown} error
   * @returns {string}
   */
  #explain(error) {
    if (error instanceof CdpClosedError) {
      const state =
        this.process === null ? '浏览器进程不存在' : `浏览器进程：${this.process.processState}`;
      return `与浏览器的连接已断开（${state}）。如果浏览器被手动关掉了，重新调用 browser_open 即可。`;
    }
    if (error instanceof CdpError) {
      if (error.code === -32000)
        return `浏览器拒绝了这次操作：${error.message}。页面可能已经变化，请重新 browser_snapshot 后再试。`;
      return error.message;
    }
    return messageOf(error);
  }

  /**
   * 取当前会话；没有就报"先启动"。
   *
   * @returns {Promise<string>}
   */
  async #requireSession() {
    if (this.connection === null || this.process === null || !this.process.alive) {
      throw new Error(
        '浏览器还没有启动。先调用 browser_open（或任何浏览器工具，它们会自动启动）。',
      );
    }
    if (this.currentSessionId === null || this.currentTargetId === null)
      await this.#attachNewestPage();
    if (this.currentSessionId === null)
      throw new Error('浏览器里没有可用的页面。用 browser_tabs { action: "new" } 新建一个。');
    return this.currentSessionId;
  }

  /** 挑一个页面 target 并 attach。优先当前 target，否则最新的一个。 */
  async #attachNewestPage() {
    if (this.connection === null) return;
    const result = await this.connection.send('Target.getTargets', {});
    const pages = (Array.isArray(result?.targetInfos) ? result.targetInfos : []).filter(
      (/** @type {any} */ info) => info.type === 'page' || info.type === 'webview',
    );
    if (pages.length === 0) {
      const created = await this.connection.send('Target.createTarget', { url: 'about:blank' });
      await this.#attach(created.targetId, true);
      return;
    }
    const preferred =
      pages.find((/** @type {any} */ info) => info.targetId === this.currentTargetId) ??
      pages[pages.length - 1];
    await this.#attach(preferred.targetId, true);
  }

  /**
   * attach 到一个 target 并启用所需域。
   *
   * @param {string} targetId
   * @param {boolean} makeCurrent
   */
  async #attach(targetId, makeCurrent) {
    const connection = this.connection;
    if (connection === null) throw new CdpClosedError('浏览器还没有启动。');
    const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    this.openTabs.set(targetId, { targetId, sessionId, url: '', title: '' });
    if (makeCurrent) {
      this.currentTargetId = targetId;
      this.currentSessionId = sessionId;
      this.refs.clear();
      await this.#enableDomains(sessionId);
    }
  }

  /**
   * @param {string} sessionId
   */
  async #enableDomains(sessionId) {
    const connection = this.connection;
    if (connection === null) return;
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) {
      try {
        await connection.send(method, {}, { sessionId });
      } catch (error) {
        // 某个域不可用不该让整个 attach 失败：其余能力照常提供。
        this.warn(`${method} 不可用：${messageOf(error)}`);
      }
    }
  }

  /** 订阅全局事件：页面崩溃、标签增删、网络与控制台。 */
  #subscribeEvents() {
    const connection = this.connection;
    if (connection === null) return;
    const dispose = connection.on((event) => {
      try {
        this.#handleEvent(event);
      } catch (error) {
        this.warn(`处理 CDP 事件 ${event.method} 出错：${messageOf(error)}`);
      }
    });
    this.eventDisposers.push(dispose);
  }

  /**
   * @param {import('./cdp.js').CdpEvent} event
   */
  #handleEvent(event) {
    switch (event.method) {
      case 'Target.targetInfoChanged': {
        const info = event.params.targetInfo;
        if (info !== undefined && this.openTabs.has(String(info.targetId))) {
          const tab = this.openTabs.get(String(info.targetId));
          if (tab !== undefined) {
            tab.url = String(info.url ?? '');
            tab.title = String(info.title ?? '');
          }
        }
        return;
      }
      case 'Target.targetDestroyed': {
        this.openTabs.delete(String(event.params.targetId));
        if (String(event.params.targetId) === this.currentTargetId) {
          this.currentTargetId = null;
          this.currentSessionId = null;
        }
        return;
      }
      case 'Inspector.targetCrashed': {
        this.warn('页面渲染进程崩溃了（Inspector.targetCrashed）。');
        this.console.push({
          level: 'error',
          text: '页面渲染进程崩溃 (Inspector.targetCrashed)',
          at: Date.now(),
          source: 'plugin',
        });
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const level = consoleLevelOf(String(event.params.type ?? 'log'));
        const text = (Array.isArray(event.params.args) ? event.params.args : [])
          .map((arg) => describeRemoteObject(arg))
          .join(' ')
          .slice(0, 2000);
        this.console.push({
          level,
          text,
          at: Number(event.params.timestamp ?? Date.now()),
          source: 'console',
        });
        this.#trimConsole();
        return;
      }
      case 'Runtime.exceptionThrown': {
        const details = event.params.exceptionDetails ?? {};
        const firstLine = String(
          details.exception?.description ?? details.text ?? '未知异常',
        ).split('\n')[0];
        const text = (firstLine ?? '').slice(0, 1000);
        this.console.push({
          level: 'error',
          text,
          at: Number(details.timestamp ?? Date.now()),
          source: 'exception',
        });
        this.#trimConsole();
        return;
      }
      case 'Log.entryAdded': {
        const entry = event.params.entry ?? {};
        const level =
          entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info';
        this.console.push({
          level,
          text: String(entry.text ?? '').slice(0, 1000),
          at: Number(entry.timestamp ?? Date.now()),
          source: `log:${String(entry.source ?? 'unknown')}`,
        });
        this.#trimConsole();
        return;
      }
      case 'Network.requestWillBeSent': {
        const request = event.params.request ?? {};
        const requestId = String(event.params.requestId ?? '');
        const entry = {
          requestId,
          method: String(request.method ?? 'GET'),
          url: String(request.url ?? ''),
          startedAt: Number(event.params.timestamp ?? Date.now()),
          type: typeof event.params.type === 'string' ? event.params.type : undefined,
        };
        this.networkByRequestId.set(requestId, entry);
        this.network.push(entry);
        this.pendingRequests.add(requestId);
        this.#trimNetwork();
        return;
      }
      case 'Network.responseReceived': {
        const requestId = String(event.params.requestId ?? '');
        const entry = this.networkByRequestId.get(requestId);
        if (entry !== undefined) {
          entry.status = Number(event.params.response?.status ?? 0);
          entry.mimeType = String(event.params.response?.mimeType ?? '');
          entry.finishedAt = Number(event.params.timestamp ?? Date.now());
          this.pendingRequests.delete(requestId);
        }
        return;
      }
      case 'Network.loadingFailed': {
        const requestId = String(event.params.requestId ?? '');
        const entry = this.networkByRequestId.get(requestId);
        if (entry !== undefined) {
          entry.failed = true;
          entry.errorText = String(event.params.errorText ?? 'unknown');
          entry.finishedAt = Number(event.params.timestamp ?? Date.now());
        }
        this.pendingRequests.delete(requestId);
        return;
      }
      case 'Network.loadingFinished': {
        const requestId = String(event.params.requestId ?? '');
        const entry = this.networkByRequestId.get(requestId);
        if (entry !== undefined) entry.finishedAt = Number(event.params.timestamp ?? Date.now());
        this.pendingRequests.delete(requestId);
        return;
      }
      case 'Page.frameNavigated': {
        // 主框架导航完成后，旧的引用号一定失效——这是引用过期的唯一权威信号。
        const frame = event.params.frame ?? {};
        if (frame.parentId === undefined) {
          this.refs.clear();
          for (const [targetId, tab] of this.openTabs) {
            if (tab.sessionId === event.sessionId)
              this.openTabs.set(targetId, { ...tab, url: String(frame.url ?? '') });
          }
        }
        return;
      }
      default:
        return;
    }
  }

  #trimConsole() {
    if (this.console.length > EVENT_BUFFER_SIZE)
      this.console.splice(0, this.console.length - EVENT_BUFFER_SIZE);
  }

  #trimNetwork() {
    if (this.network.length > EVENT_BUFFER_SIZE) {
      const dropped = this.network.splice(0, this.network.length - EVENT_BUFFER_SIZE);
      for (const entry of dropped) this.networkByRequestId.delete(entry.requestId);
    }
  }

  /**
   * 等页面加载到指定阶段。
   *
   * @param {string} sessionId
   * @param {'domcontentloaded' | 'load'} stage
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} 超时返回 false（调用方仍然能读到当前状态）
   */
  async #waitForLoad(sessionId, stage, timeoutMs) {
    const target = stage === 'load' ? 'complete' : 'interactive';
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = await this.#evaluate('document.readyState', { sessionId, returnByValue: true });
      if (state === target || state === 'complete') return true;
      await sleep(100);
    }
    return false;
  }

  /**
   * 给页面一点时间把动作的后果反映出来。
   *
   * 刻意很短：这是"让 DOM 更新"的喘息，不是等待条件成立（那是 browser_wait 的事）。
   */
  async #settle() {
    await sleep(120);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<PageState>}
   */
  async #pageState(sessionId) {
    const state = await this.#evaluate(PAGE_STATE_SCRIPT, { sessionId, returnByValue: true });
    const tab = this.currentTargetId === null ? undefined : this.openTabs.get(this.currentTargetId);
    if (tab !== undefined && typeof state?.url === 'string') tab.url = state.url;
    return {
      url: String(state?.url ?? ''),
      title: String(state?.title ?? ''),
      readyState: String(state?.readyState ?? 'unknown'),
      text: String(state?.text ?? ''),
    };
  }

  /**
   * 生成一段"在页面里找到目标元素"的表达式。
   *
   * ref 与 selector 两条定位路径必须在所有动作里走同一段代码：分别实现过一次的
   * 地方都出现了"ref 可用、selector 静默失效"这类不一致，索性收敛成一个出口。
   *
   * @param {string | undefined} ref
   * @param {string | undefined} selector
   * @returns {string} 求值为 Element 或 null 的表达式
   */
  #queryExpression(ref, selector) {
    if (typeof ref === 'string' && ref !== '')
      return `document.querySelector('[${REF_ATTRIBUTE}="${ref}"]')`;
    if (typeof selector === 'string' && selector !== '')
      return `document.querySelector(${JSON.stringify(selector)})`;
    return 'null';
  }

  /**
   * 把 ref/selector/坐标解析成一个可点击的点。
   *
   * @param {{ ref?: string, selector?: string, x?: number, y?: number }} target
   * @param {string} sessionId
   * @returns {Promise<{ x: number, y: number, ref?: string, selector?: string, description: string, scrolled?: boolean }>}
   */
  async #resolvePoint(target, sessionId) {
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      return {
        x: Math.round(target.x),
        y: Math.round(target.y),
        description: `坐标 (${Math.round(target.x)}, ${Math.round(target.y)})`,
      };
    }
    const ref = typeof target.ref === 'string' && target.ref !== '' ? target.ref : undefined;
    const selector =
      typeof target.selector === 'string' && target.selector !== '' ? target.selector : undefined;
    if (ref === undefined && selector === undefined) {
      throw new Error(
        '必须给出定位方式之一：ref（来自 browser_snapshot）、selector，或 x/y 坐标。',
      );
    }
    if (ref !== undefined && !this.refs.has(ref)) {
      throw new Error(
        `引用号 ${ref} 已经失效（页面变化或来自更早的快照）。重新调用 browser_snapshot 拿到新的引用号。`,
      );
    }
    const query = this.#queryExpression(ref, selector);
    const box = await this.#evaluate(
      `(() => { const el = ${query}; if (!el) return null;
         const rect = el.getBoundingClientRect();
         if (rect.width < 1 || rect.height < 1) return { zero: true };
         return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height, tag: el.tagName.toLowerCase() }; })()`,
      { sessionId, returnByValue: true },
    );
    if (box === null || box === undefined) {
      const what = ref !== undefined ? `引用号 ${ref}` : `选择器 ${selector}`;
      throw new Error(`在页面里找不到${what}。引用号会随页面变化失效，请重新 browser_snapshot。`);
    }
    if (box.zero === true) {
      throw new Error(`${ref ?? selector} 对应的元素尺寸为 0（不可见或未渲染），无法点击或输入。`);
    }
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      ref,
      selector,
      description:
        `${box.tag} ${ref ?? selector ?? ''} 中心 (${Math.round(box.x)}, ${Math.round(box.y)})`.trim(),
    };
  }

  /**
   * 元素不在视口里时先滚动到中间。返回是否滚动过——这件事要如实报告，
   * 因为它会影响后续基于坐标的判断。
   *
   * @param {{ ref?: string, selector?: string, scrolled?: boolean }} resolved
   * @param {string} sessionId
   */
  async #scrollIntoViewIfNeeded(resolved, sessionId) {
    const query = this.#queryExpression(resolved.ref, resolved.selector);
    if (query === 'null') return;
    const visible = await this.#evaluate(
      `(() => { const el = ${query}; if (!el) return false;
         const r = el.getBoundingClientRect();
         return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })()`,
      { sessionId, returnByValue: true },
    );
    if (visible === true) return;
    await this.#evaluate(
      `(() => { const el = ${query}; if (el) el.scrollIntoView({ block: 'center', inline: 'center' }); return true; })()`,
      { sessionId, returnByValue: true },
    );
    resolved.scrolled = true;
    await sleep(60);
  }

  /**
   * @param {{ ref?: string, selector?: string }} resolved
   * @param {string} sessionId
   */
  async #focus(resolved, sessionId) {
    const query = this.#queryExpression(resolved.ref, resolved.selector);
    if (query === 'null') return;
    await this.#evaluate(
      `(() => { const el = ${query}; if (!el) return false; el.focus(); return true; })()`,
      { sessionId, returnByValue: true },
    );
  }

  /**
   * @param {{ selector?: string, text?: string, networkIdleMs?: number }} options
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async #checkCondition(options, sessionId) {
    if (typeof options.selector === 'string' && options.selector !== '') {
      const exists = await this.#evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); if (!el) return false;
           const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
           return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; })()`,
        { sessionId, returnByValue: true },
      );
      return exists === true;
    }
    if (typeof options.text === 'string' && options.text !== '') {
      const found = await this.#evaluate(
        `(() => { const needle = ${JSON.stringify(options.text)}; const hay = document.body ? document.body.innerText : ''; return hay.includes(needle); })()`,
        { sessionId, returnByValue: true },
      );
      return found === true;
    }
    return this.pendingRequests.size === 0;
  }

  /**
   * 动作后的统一回读。
   *
   * @param {string} action
   * @param {{ x?: number, y?: number, description?: string }} target
   * @param {Record<string, unknown>} [extra]
   * @returns {Promise<ActionReport>}
   */
  async #actionReport(action, target, extra = {}) {
    const sessionId = this.currentSessionId;
    /** @type {PageState} */
    let page = { url: '', title: '', readyState: 'unknown', text: '' };
    if (sessionId !== null) {
      try {
        page = await this.#pageState(sessionId);
      } catch (error) {
        page = { url: '', title: '', readyState: 'unknown', text: '', error: messageOf(error) };
      }
    }
    const consoleTail = this.console.slice(-5);
    const failedRequests = this.network.filter((entry) => entry.failed === true).slice(-5);
    return {
      action,
      target: target.description ?? '',
      ok: page.error === undefined,
      pageError: page.error,
      page,
      console: consoleTail,
      failedRequests,
      ...extra,
    };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ width: number, height: number }>}
   */
  async #viewportMetrics(sessionId) {
    const metrics = await this.#evaluate('({ width: innerWidth, height: innerHeight })', {
      sessionId,
      returnByValue: true,
    });
    return { width: Number(metrics?.width ?? 0), height: Number(metrics?.height ?? 0) };
  }

  /** 连接信息（不含敏感内容）。 */
  #connectionReport() {
    return {
      running: true,
      port: this.port,
      browser: this.version?.browser ?? 'unknown',
      protocolVersion: this.version?.protocolVersion ?? 'unknown',
      product: this.product,
      sandboxDisabled: this.sandboxDisabled,
      profileDir: this.process?.userDataDir ?? '',
      cdpEndpoint: `http://127.0.0.1:${this.port ?? 0}`,
    };
  }

  /**
   * 断开连接。默认连带停掉进程，`keepProcess` 为真时只断连接。
   *
   * @param {{ keepProcess?: boolean }} [options]
   */
  async #shutdownInternal(options = {}) {
    for (const dispose of this.eventDisposers) dispose();
    this.eventDisposers = [];
    if (this.connection !== null) {
      this.connection.close();
      this.connection = null;
    }
    if (options.keepProcess !== true && this.process !== null && this.process.alive) {
      await this.process.stop({ gracefulTimeoutMs: 3000, killTimeoutMs: 2000 });
    }
    if (options.keepProcess !== true) this.process = null;
    this.currentSessionId = null;
    this.currentTargetId = null;
    this.openTabs.clear();
    this.refs.clear();
    this.pendingRequests.clear();
  }
}

/**
 * 把 URL 规范化：补 scheme 是必要的，因为 `example.com` 这种输入太常见了。
 *
 * @param {string} url
 * @returns {string}
 */
export function normaliseUrl(url) {
  const trimmed = url.trim();
  if (trimmed === '') throw new Error('URL 不能为空。');
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * 键名到 CDP 按键描述的映射。
 *
 * 只覆盖常用键：不追求完备，因为发一个不认识的键会静默变成无效输入，
 * 那比明确报错更糟（未知键会抛错）。
 *
 * @param {string} key
 * @param {string[]} modifiers
 * @returns {{ key: string, code: string, windowsVirtualKeyCode: number, modifiers: number, text?: string }}
 */
export function describeKey(key, modifiers = []) {
  /** @type {Record<string, { code: string, vk: number, text?: string }>} */
  const table = {
    Enter: { code: 'Enter', vk: 13, text: '\r' },
    Tab: { code: 'Tab', vk: 9 },
    Escape: { code: 'Escape', vk: 27 },
    Backspace: { code: 'Backspace', vk: 8 },
    Delete: { code: 'Delete', vk: 46 },
    ArrowUp: { code: 'ArrowUp', vk: 38 },
    ArrowDown: { code: 'ArrowDown', vk: 40 },
    ArrowLeft: { code: 'ArrowLeft', vk: 37 },
    ArrowRight: { code: 'ArrowRight', vk: 39 },
    Home: { code: 'Home', vk: 36 },
    End: { code: 'End', vk: 35 },
    PageUp: { code: 'PageUp', vk: 33 },
    PageDown: { code: 'PageDown', vk: 34 },
    Space: { code: 'Space', vk: 32, text: ' ' },
  };
  const named = table[key];
  if (named === undefined) {
    if (key.length === 1) {
      const upper = key.toUpperCase();
      return {
        key,
        code: `Key${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        modifiers: modifierMask(modifiers),
        text: key,
      };
    }
    throw new Error(`不支持的按键 ${key}。可用：${Object.keys(table).join('、')}，或单个字符。`);
  }
  return {
    key,
    code: named.code,
    windowsVirtualKeyCode: named.vk,
    modifiers: modifierMask(modifiers),
    ...(named.text === undefined ? {} : { text: named.text }),
  };
}

/**
 * @param {string[]} modifiers
 * @returns {number}
 */
export function modifierMask(modifiers) {
  let mask = 0;
  for (const modifier of modifiers) {
    const normalised = modifier.toLowerCase();
    if (normalised === 'alt') mask |= 1;
    else if (normalised === 'ctrl' || normalised === 'control') mask |= 2;
    else if (normalised === 'meta' || normalised === 'cmd' || normalised === 'command') mask |= 4;
    else if (normalised === 'shift') mask |= 8;
    else throw new Error(`不支持的修饰键 ${modifier}。可用：Alt、Ctrl、Meta（Cmd）、Shift。`);
  }
  return mask;
}

/**
 * 把 Runtime.consoleAPICalled 的参数投影成一行文本。
 *
 * @param {any} arg
 * @returns {string}
 */
export function describeRemoteObject(arg) {
  if (arg === null || typeof arg !== 'object') return String(arg);
  if (typeof arg.value === 'string') return arg.value;
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  if (typeof arg.description === 'string') return arg.description;
  return String(arg.type ?? 'unknown');
}

/**
 * console 类型到级别。
 *
 * @param {string} type
 * @returns {'error' | 'warning' | 'info' | 'debug'}
 */
export function consoleLevelOf(type) {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning' || type === 'warn') return 'warning';
  if (type === 'debug' || type === 'trace') return 'debug';
  return 'info';
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @typedef {object} PageState
 * @property {string} url
 * @property {string} title
 * @property {string} readyState
 * @property {string} text
 * @property {string} [error]
 */

/**
 * @typedef {object} BrowserOpenReport
 * @property {boolean} running
 * @property {boolean} reused
 * @property {number | null} port
 * @property {string} browser
 * @property {string} protocolVersion
 * @property {string | null} product
 * @property {boolean} sandboxDisabled
 * @property {string} profileDir
 * @property {string} cdpEndpoint
 * @property {PageState} page
 */

/**
 * @typedef {object} SnapshotItem
 * @property {string} ref
 * @property {string} tag
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {boolean} inViewport
 * @property {Record<string, unknown>} state
 * @property {string} [role]
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [href]
 */

/**
 * @typedef {object} Snapshot
 * @property {string} url
 * @property {string} title
 * @property {string} readyState
 * @property {number} scrollY
 * @property {number} scrollHeight
 * @property {{ width: number, height: number }} viewport
 * @property {number} total
 * @property {boolean} truncated
 * @property {SnapshotItem[]} items
 * @property {number} [scopedCount]
 */

/**
 * @typedef {object} ActionReport
 * @property {string} action
 * @property {string} target
 * @property {boolean} ok
 * @property {string} [pageError]
 * @property {PageState} page
 * @property {ConsoleEntry[]} console
 * @property {NetworkEntry[]} failedRequests
 */

/**
 * @typedef {object} NetworkEntry
 * @property {string} requestId
 * @property {string} method
 * @property {string} url
 * @property {number} startedAt
 * @property {number} [status]
 * @property {string} [mimeType]
 * @property {number} [finishedAt]
 * @property {boolean} [failed]
 * @property {string} [errorText]
 * @property {string} [type]
 */

/**
 * @typedef {object} ConsoleEntry
 * @property {'error' | 'warning' | 'info' | 'debug'} level
 * @property {string} text
 * @property {number} at
 * @property {string} source
 */

/**
 * @typedef {object} TabInfo
 * @property {string} targetId
 * @property {string} url
 * @property {string} title
 * @property {boolean} current
 */
