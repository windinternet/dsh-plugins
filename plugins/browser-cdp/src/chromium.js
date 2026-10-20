/**
 * 受管 Chromium 进程的生命周期。
 *
 * 这个模块只负责"把浏览器拉起来、确认它真的可用、需要时把它收回去"，
 * 不理解任何页面语义（那在 session.js）。
 *
 * 三条实测结论决定了这里的实现，不是设计偏好：
 *
 * 1. **--remote-debugging-port 只能在进程启动时给。** 运行中的浏览器无法追加这个开关，
 *    所以必须由我们自己 spawn 一个实例。
 * 2. **绝不能碰用户正在用的浏览器。** 因此强制 `--user-data-dir=<插件数据目录>`：
 *    Chrome 在 profile 目录已被占用时会直接退出，这反过来成了一道保护，
 *    我们永远不会劫持用户自己的会话与登录态。
 * 3. **宿主若运行在受限沙箱里，Chromium 的渲染进程会立刻 SIGTRAP。**
 *    这是本机实测（见 docs/references/chromium-cdp-facts.md）：加 `--no-sandbox`
 *    才能起来。但这不是所有环境的常态，所以策略是"先按正常方式起，起不来再回退"，
 *    并且把回退这件事如实报告给调用方，而不是默认降级。
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverBrowser, describeMissingBrowser, productNameOf } from './launcher.js';
import { parsePortRange, selectFreePort, waitForCdpEndpoint } from './ports.js';

/** 崩溃判定窗口：这段时间内进程消失，就认为是"没起来"而不是"跑完退出"。 */
export const CRASH_WINDOW_MS = 3000;

/** 启动到 DevTools 端点可用的总预算。冷启动实测 1~4 秒，给足余量。 */
export const ENDPOINT_TIMEOUT_MS = 20000;

/** 与用户浏览器区分开的窗口尺寸默认值。 */
export const DEFAULT_WINDOW_SIZE = /** @type {const} */ ([1440, 900]);

/**
 * 插件配置中与浏览器进程相关的字段。定义在这里而不是引用 index.js，
 * 是为了让 src/ 保持"不依赖宿主、可单独测试"的边界。
 *
 * @typedef {object} BrowserConfig
 * @property {string} [dataDir]
 * @property {string} [executablePath]
 * @property {string[]} [browserPaths]
 * @property {unknown} [portRange]
 * @property {boolean} [headless]
 * @property {'new' | 'old'} [headlessMode]
 * @property {boolean} [allowSandbox]
 * @property {string[]} [chromiumArgs]
 * @property {number[]} [windowSize]
 * @property {number} [commandTimeoutMs]
 */

/**
 * @typedef {object} LaunchOptions
 * @property {string} executablePath
 * @property {number} port
 * @property {string} userDataDir
 * @property {boolean} headless
 * @property {'new' | 'old'} headlessMode
 * @property {boolean} allowSandbox
 * @property {string[]} extraArgs
 * @property {[number, number]} windowSize
 * @property {string} initialUrl
 */

/**
 * 组装命令行参数。
 *
 * 独立成纯函数是为了可测：参数拼错是这类插件最常见的低级错误，
 * 而它只在真机启动时才会暴露。
 *
 * @param {LaunchOptions} options
 * @returns {string[]}
 */
export function buildChromiumArgs(options) {
  /** @type {string[]} */
  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.userDataDir}`,
    `--window-size=${options.windowSize[0]},${options.windowSize[1]}`,
    // 自动化实例不需要这些噪声：首次运行向导、默认浏览器检查、翻译弹窗、
    // 后台网络请求与"Chrome 正在被自动化软件控制"的信息条。
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    // 让崩溃尽早暴露成"进程消失"，而不是变成一次莫名其妙的命令超时。
    '--disable-breakpad',
  ];
  if (options.headless) args.push(`--headless=${options.headlessMode}`);
  if (!options.allowSandbox) args.push('--no-sandbox');
  args.push(...options.extraArgs);
  // 初始页面放在最后：前面的都是开关，URL 是位置参数。
  args.push(options.initialUrl);
  return args;
}

/**
 * 一个受管浏览器进程。
 */
export class BrowserProcess {
  /**
   * @param {object} options
   * @param {string} options.executablePath
   * @param {number} options.port
   * @param {string} options.userDataDir
   * @param {import('node:child_process').ChildProcess} options.child
   * @param {boolean} options.allowSandbox
   * @param {boolean} options.headless
   * @param {string} options.productName
   */
  constructor(options) {
    this.executablePath = options.executablePath;
    this.port = options.port;
    this.userDataDir = options.userDataDir;
    this.child = options.child;
    this.allowSandbox = options.allowSandbox;
    this.headless = options.headless;
    this.productName = options.productName;
    /** @type {number | null} */
    this.exitCode = null;
    /** @type {NodeJS.Signals | null} */
    this.exitSignal = null;
    /** @type {string[]} */
    this.stderrTail = [];
    options.child.once('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
    });
    options.child.stderr?.on('data', (chunk) => {
      // 只留尾部若干行：很多启动失败的原因只出现在 stderr 里，丢弃它会让人无从排查。
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        this.stderrTail.push(trimmed);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });
  }

  /** 进程是否还活着。 */
  get alive() {
    return this.exitCode === null && this.exitSignal === null;
  }

  /** 一份可解释的进程状态描述。 */
  get processState() {
    if (this.alive) return 'running';
    if (this.exitSignal !== null) return `killed by ${this.exitSignal}`;
    return `exited with code ${this.exitCode}`;
  }

  /**
   * 停止进程：先温和终止，超时后强杀，并等待它真的消失。
   *
   * 不做乐观返回：发完信号就说"已停止"会让下一次启动撞上残留进程。
   *
   * @param {{ gracefulTimeoutMs?: number, killTimeoutMs?: number }} [options]
   * @returns {Promise<{ stopped: boolean, method: 'exited' | 'sigterm' | 'sigkill' | 'none', waitedMs: number }>}
   */
  async stop(options = {}) {
    const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 4000;
    const killTimeoutMs = options.killTimeoutMs ?? 3000;
    const started = Date.now();
    if (!this.alive) return { stopped: true, method: 'exited', waitedMs: 0 };

    this.#signal('SIGTERM');
    if (await this.#waitForExit(gracefulTimeoutMs)) {
      return { stopped: true, method: 'sigterm', waitedMs: Date.now() - started };
    }
    this.#signal('SIGKILL');
    if (await this.#waitForExit(killTimeoutMs)) {
      return { stopped: true, method: 'sigkill', waitedMs: Date.now() - started };
    }
    return { stopped: false, method: 'none', waitedMs: Date.now() - started };
  }

  /**
   * @param {NodeJS.Signals} signal
   */
  #signal(signal) {
    try {
      this.child.kill(signal);
    } catch {
      /* 进程可能刚刚自己退了；下面统一用 alive 判定。 */
    }
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  #waitForExit(timeoutMs) {
    if (!this.alive) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(!this.alive), timeoutMs);
      const check = setInterval(() => {
        if (!this.alive) {
          clearTimeout(timer);
          clearInterval(check);
          resolve(true);
        }
      }, 100);
      this.child.once('exit', () => {
        clearTimeout(timer);
        clearInterval(check);
        resolve(true);
      });
    });
  }
}

/**
 * 启动一个受管浏览器。
 *
 * @param {object} options
 * @param {BrowserConfig} options.config 已解析的插件配置
 * @param {string} options.dataDir 插件数据目录（profile 会落在它下面）
 * @param {string} [options.initialUrl]
 * @param {number} [options.preferredPort] 上次用过的端口，优先复用避免端口漂移
 * @param {boolean} [options.headless] 覆盖配置
 * @param {(message: string) => void} [options.warn]
 * @returns {Promise<
 *   | { ok: true, process: BrowserProcess, version: import('./ports.js').CdpVersion, port: number, product: string, sandboxDisabled: boolean, waitedMs: number }
 *   | { ok: false, error: string, detail: string[] }
 * >}
 */
export async function launchBrowser(options) {
  const warn = options.warn ?? (() => {});
  const { range, problem } = parsePortRange(options.config.portRange);
  if (problem !== null) warn(problem);

  const found = discoverBrowser({
    configured: options.config.executablePath,
    candidates: options.config.browserPaths,
  });
  if (found.path === null) {
    return {
      ok: false,
      error: '找不到可用的浏览器。',
      detail: describeMissingBrowser(found).split('\n'),
    };
  }
  const executablePath = found.path;
  const product = productNameOf(executablePath);

  const selection = await selectFreePort({ range, preferred: options.preferredPort });
  if (selection.port === 0) {
    return { ok: false, error: '没有可用端口。', detail: [selection.reason ?? '端口范围已耗尽。'] };
  }

  const headless = options.headless ?? options.config.headless ?? true;
  const headlessMode = options.config.headlessMode ?? 'new';
  const allowSandbox = options.config.allowSandbox === true;
  const extraArgs = (
    Array.isArray(options.config.chromiumArgs) ? options.config.chromiumArgs : []
  ).map((arg) => String(arg));
  const configuredWindow = Array.isArray(options.config.windowSize)
    ? options.config.windowSize
    : [];
  const windowSize =
    configuredWindow.length === 2
      ? /** @type {[number, number]} */ ([Number(configuredWindow[0]), Number(configuredWindow[1])])
      : /** @type {[number, number]} */ ([...DEFAULT_WINDOW_SIZE]);
  const initialUrl = options.initialUrl ?? 'about:blank';
  const userDataDir = join(options.dataDir, 'chromium-profile');
  try {
    mkdirSync(userDataDir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: '无法创建浏览器 profile 目录。',
      detail: [`${userDataDir}：${error instanceof Error ? error.message : String(error)}`],
    };
  }

  /**
   * 试一次启动。`attemptAllowSandbox` 为 false 时加 --no-sandbox。
   * @param {boolean} attemptAllowSandbox
   */
  const attempt = async (attemptAllowSandbox) => {
    const args = buildChromiumArgs({
      executablePath,
      port: selection.port,
      userDataDir,
      headless,
      headlessMode,
      allowSandbox: attemptAllowSandbox,
      extraArgs,
      windowSize,
      initialUrl,
    });
    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    });
    const process_ = new BrowserProcess({
      executablePath,
      port: selection.port,
      userDataDir,
      child,
      allowSandbox: attemptAllowSandbox,
      headless,
      productName: product,
    });
    const endpoint = await waitForCdpEndpoint(selection.port, { timeoutMs: ENDPOINT_TIMEOUT_MS });
    if (endpoint.ok && process_.alive) {
      return {
        ok: /** @type {const} */ (true),
        process: process_,
        version: endpoint.version,
        waitedMs: endpoint.waitedMs,
      };
    }
    // 失败路径：把这次尝试的进程收干净，避免留下一个半死的实例占着端口。
    const stopped = await process_.stop({ gracefulTimeoutMs: 1500, killTimeoutMs: 1500 });
    return {
      ok: /** @type {const} */ (false),
      failure: {
        alive: process_.alive,
        processState: process_.processState,
        endpointReason: endpoint.ok ? '端点可用但进程已退出' : endpoint.reason,
        stopped: stopped.stopped,
        stderr: process_.stderrTail.slice(-8),
      },
    };
  };

  const first = await attempt(allowSandbox);
  if (first.ok) {
    return {
      ok: true,
      process: first.process,
      version: first.version,
      port: selection.port,
      product,
      sandboxDisabled: !allowSandbox,
      waitedMs: first.waitedMs,
    };
  }

  // 只有当我们本来开着沙箱、且进程确实是在崩溃窗口内死掉时，才回退一次。
  const crashed = first.failure.alive === false;
  if (allowSandbox && crashed) {
    warn(
      `${product} 在启用沙箱的情况下未能启动（${first.failure.processState}），正在关闭浏览器沙箱重试一次。`,
    );
    const second = await attempt(false);
    if (second.ok) {
      return {
        ok: true,
        process: second.process,
        version: second.version,
        port: selection.port,
        product,
        sandboxDisabled: true,
        waitedMs: second.waitedMs,
      };
    }
    return formatLaunchFailure(product, executablePath, selection.port, second.failure, true);
  }

  return formatLaunchFailure(product, executablePath, selection.port, first.failure, false);
}

/**
 * 把启动失败整理成有结论的返回值。
 *
 * @param {string} product
 * @param {string} executablePath
 * @param {number} port
 * @param {{ alive: boolean, processState: string, endpointReason: string, stopped: boolean, stderr: string[] }} failure
 * @param {boolean} triedFallback
 * @returns {{ ok: false, error: string, detail: string[] }}
 */
function formatLaunchFailure(product, executablePath, port, failure, triedFallback) {
  const detail = [
    `可执行文件：${executablePath}`,
    `端口：${port}`,
    `进程状态：${failure.processState}`,
    `DevTools 端点：${failure.endpointReason}`,
  ];
  if (triedFallback) detail.push('已尝试关闭浏览器沙箱重试，仍然失败。');
  if (!failure.stopped) detail.push('警告：失败实例可能没有完全退出，端口可能仍被占用。');
  if (failure.stderr.length > 0) {
    detail.push('浏览器 stderr 末尾：');
    detail.push(...failure.stderr.map((line) => `  ${line}`));
  }
  return { ok: false, error: `${product} 启动失败。`, detail };
}
