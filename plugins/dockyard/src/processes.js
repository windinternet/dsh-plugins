/**
 * 外部进程发现与接管。
 *
 * 场景：服务是用户在终端里手动起的 `pnpm dev` / `npm run dev`，dockyard 没有句柄。
 * 插件不能凭空拿到它的 stdout 或退出事件，但可以：
 * 1. 枚举系统进程，按 **cwd 是否在项目根目录下** 认出“这是某个项目的进程”；
 * 2. 读取 CPU/内存与监听端口，展示出来；
 * 3. 用户确认后优雅终止这些进程，再由 dockyard 按项目的启动命令重新拉起，完成接管。
 *
 * 这里的命令只做只读枚举与终止，不经过 shell。所有解析失败都变成错误信息，
 * 不抛到调用方；终止只允许操作 cwd 在项目根内、且不是当前进程的 pid。
 */

import { execFile } from 'node:child_process';
import { sep } from 'node:path';
import { promisify } from 'node:util';
import { isProcessAlive } from './internal/process-supervisor.js';

const execFileAsync = promisify(execFile);

/**
 * @typedef {object} ExternalProcess
 * @property {number} pid
 * @property {number} ppid
 * @property {number} pgid
 * @property {number} cpuPercent
 * @property {number} rssBytes
 * @property {string} command
 * @property {string} cwd
 * @property {number[]} ports
 * @property {string} root 命中的项目根目录
 * @property {string} [projectId] 归属项目 id（已知时）
 * @property {string} [projectName] 归属项目名（已知时）
 */

/**
 * 解析 `ps -axo pid=,ppid=,pgid=,%cpu=,rss=,command=` 的输出。
 * @param {string} text
 * @returns {{ pid: number, ppid: number, pgid: number, cpuPercent: number, rssBytes: number, command: string }[]}
 */
export function parsePsProcesses(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      cpuPercent: Number(match[4]),
      rssBytes: Number(match[5]) * 1024,
      command: match[6] ?? '',
    });
  }
  return out;
}

/**
 * 解析 `lsof -nP -d cwd -Fn` 的输出为 pid → cwd。
 * @param {string} text
 * @returns {Map<number, string>}
 */
export function parseLsofCwd(text) {
  /** @type {Map<number, string>} */
  const map = new Map();
  let pid = 0;
  let isCwd = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1)) || 0;
      isCwd = false;
    } else if (line === 'fcwd') {
      isCwd = true;
    } else if (isCwd && line.startsWith('n') && pid > 0) {
      map.set(pid, line.slice(1));
      isCwd = false;
    }
  }
  return map;
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN -Fn` 的输出为 pid → 监听端口。
 * @param {string} text
 * @returns {Map<number, number[]>}
 */
export function parseLsofPorts(text) {
  /** @type {Map<number, number[]>} */
  const map = new Map();
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1)) || 0;
      continue;
    }
    if (pid === 0 || !line.startsWith('n')) continue;
    const match = line.match(/:(\d+)$/);
    if (!match) continue;
    const port = Number(match[1]);
    const ports = map.get(pid) ?? [];
    if (!ports.includes(port)) ports.push(port);
    map.set(pid, ports);
  }
  return map;
}

/**
 * 判断是否像长期运行的服务进程。仅按 cwd 匹配会把用户“停在项目目录里的终端”
 * 也算进来，接管时误杀。这里要求命令像服务启动器，或者进程正在监听端口。
 * @param {string} command
 * @param {number[]} ports
 * @returns {boolean}
 */
export function isServiceLikeProcess(command, ports) {
  if (ports.length > 0) return true;
  const normalized = command.toLowerCase();
  if (
    /(^|\/)(zsh|bash|sh|fish|login|tmux|screen|vim|nvim|nano|less|git|code|cursor|idea|webstorm)(\s|$)/.test(
      normalized,
    )
  ) {
    return false;
  }
  if (normalized.includes('deepseek harness') || normalized.includes('dsh web')) return false;
  return /(^|\/)(node|npm|npx|pnpm|yarn|bun|deno|tsx|ts-node|vite|nuxt|next|turbo|nodemon|java|mvn|gradle|go|cargo|php|artisan|flutter|dart|python\d*|uvicorn|gunicorn|rails|dotnet)(\s|$)/.test(
    normalized,
  );
}

/**
 * 判断 cwd 是否在某个根目录内，返回最长匹配根。
 * @param {string} cwd
 * @param {string[]} roots
 * @returns {string | null}
 */
function matchRoot(cwd, roots) {
  /** @type {string | null} */
  let matched = null;
  for (const root of roots) {
    if (cwd === root || cwd.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
      if (matched === null || root.length > matched.length) matched = root;
    }
  }
  return matched;
}

/**
 * 枚举外部进程。
 * @param {{ roots: string[], managedPids?: number[], platform?: NodeJS.Platform }} options
 * @returns {Promise<{ processes: ExternalProcess[], error: string }>}
 */
export async function listExternalProcesses(options) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    return { processes: [], error: `当前平台 ${platform} 暂不支持外部进程发现。` };
  }
  if (options.roots.length === 0) return { processes: [], error: '' };

  const psCommand = platform === 'darwin' ? '/bin/ps' : 'ps';
  const lsofCommand = platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  let psText;
  try {
    const result = await execFileAsync(
      psCommand,
      ['-axo', 'pid=,ppid=,pgid=,%cpu=,rss=,command='],
      {
        timeout: 3000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    psText = String(result.stdout);
  } catch (error) {
    return {
      processes: [],
      error: `无法枚举进程（ps）：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const [cwdText, portsText] = await Promise.all([
    execFileAsync(lsofCommand, ['-nP', '-d', 'cwd', '-Fn'], {
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    })
      .then((result) => String(result.stdout))
      .catch(() => ''),
    execFileAsync(lsofCommand, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
      .then((result) => String(result.stdout))
      .catch(() => ''),
  ]);

  const parsed = parsePsProcesses(psText);
  const byPid = new Map(parsed.map((item) => [item.pid, item]));
  const cwdByPid = parseLsofCwd(cwdText);
  const portsByPid = parseLsofPorts(portsText);
  const dockyardPids = new Set(
    (options.managedPids ?? []).filter((pid) => Number.isInteger(pid) && pid > 1),
  );
  const managed = new Set(dockyardPids);
  // 把当前进程及其祖先链排除：DSH / 插件宿主可能正好以某个项目目录为 cwd，
  // 不能把“自己”当成可接管的外部服务。
  let cursor = process.pid;
  for (let depth = 0; depth < 32 && cursor > 1; depth += 1) {
    managed.add(cursor);
    cursor = byPid.get(cursor)?.ppid ?? 0;
  }

  /**
   * 判断进程是否属于 dockyard 自己启动的应用树。
   *
   * 只比较 managedPids 是不行的：启动器是 detached 的进程组首进程，真正的应用是它的
   * 子进程；如果只排除启动器 pid，应用进程就会被当成“外部进程”，同一个应用在
   * 托管/非托管之间来回跳。这里同时按进程组和祖先链排除整棵树。
   * @param {{ pid: number, ppid: number, pgid: number }} item
   * @returns {boolean}
   */
  const belongsToDockyard = (item) => {
    if (dockyardPids.has(item.pid) || dockyardPids.has(item.pgid)) return true;
    let parent = item.ppid;
    for (let depth = 0; depth < 32 && parent > 1; depth += 1) {
      if (dockyardPids.has(parent)) return true;
      parent = byPid.get(parent)?.ppid ?? 0;
    }
    return false;
  };

  /** @type {ExternalProcess[]} */
  const processes = [];

  for (const item of parsed) {
    if (
      item.pid <= 1 ||
      item.pid === process.pid ||
      managed.has(item.pid) ||
      belongsToDockyard(item)
    ) {
      continue;
    }
    const cwd = cwdByPid.get(item.pid);
    if (!cwd) continue;
    const root = matchRoot(cwd, options.roots);
    if (!root) continue;
    const ports = portsByPid.get(item.pid) ?? [];
    if (!isServiceLikeProcess(item.command, ports)) continue;
    processes.push({
      ...item,
      cwd,
      root,
      ports,
    });
  }

  processes.sort((a, b) => a.root.localeCompare(b.root) || a.pid - b.pid);
  return { processes, error: '' };
}

/**
 * 等待进程消失。
 * @param {number} pid
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

/**
 * 终止一个外部进程（组）。只对确认属于项目的进程调用。
 * @param {{ pid: number, pgid: number }} target
 * @param {{ gracefulTimeoutMs?: number, killTimeoutMs?: number }} [options]
 * @returns {Promise<{ stopped: boolean, reason: string }>}
 */
export async function terminateExternalProcess(target, options = {}) {
  if (target.pid <= 1 || target.pid === process.pid) {
    return { stopped: false, reason: '拒绝终止当前进程或系统进程。' };
  }
  const useGroup = target.pgid === target.pid;
  const signal = (/** @type {NodeJS.Signals} */ sig) => {
    try {
      process.kill(useGroup ? -target.pid : target.pid, sig);
      return true;
    } catch (error) {
      return /** @type {any} */ (error).code === 'ESRCH';
    }
  };

  signal('SIGTERM');
  if (await waitGone(target.pid, options.gracefulTimeoutMs ?? 5000)) {
    return { stopped: true, reason: '已发送 SIGTERM 并退出。' };
  }
  signal('SIGKILL');
  if (await waitGone(target.pid, options.killTimeoutMs ?? 3000)) {
    return { stopped: true, reason: 'SIGTERM 超时后已 SIGKILL。' };
  }
  return { stopped: false, reason: '进程在 SIGKILL 后仍未消失。' };
}
