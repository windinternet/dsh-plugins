/**
 * 进程监管：启动、停止（带信号升级）、状态观测。
 *
 * 三条设计约束，每条都有具体代价在背后：
 *
 * 1. **进程必须归调用方所有。** 用 detached 让子进程自成一个进程组，
 *    这样"关掉终端/停掉调用方"不会顺手杀掉被托管的服务；也让停止时能对
 *    整个进程组下手，连同服务自己拉起的子进程一起回收。
 *
 * 2. **停止必须真的等到进程消失。** 只发信号就返回，会让面板显示"已停止"
 *    而系统里还有残留进程，用户下次启动就撞端口。所以停止是一个异步过程：
 *    先温和终止，超时后升级为强杀，最后确认进程确实不在了。
 *
 * 3. **状态变化要能被观测。** 进程可能自己崩溃，这时外部没有任何人调用停止。
 *    所以必须监听退出事件并对外通告，否则状态会永久停在"运行中"。
 */

import { spawn } from 'node:child_process';

/**
 * @typedef {'starting'|'running'|'stopping'|'stopped'|'crashed'} ProcessStatus
 */

/**
 * @typedef {object} StartOptions
 * @property {string} id 唯一标识
 * @property {string} command 可执行文件
 * @property {string[]} [args]
 * @property {string} cwd 工作目录
 * @property {Record<string,string>} [env] 追加的环境变量（会与当前环境合并）
 * @property {(stream: 'stdout'|'stderr'|'system', text: string) => void} [onOutput]
 * @property {(status: ProcessStatus, detail: { code: number|null, signal: string|null }) => void} [onExit]
 * @property {boolean} [isolateProcessGroup] 是否让子进程成为独立进程组，默认 true。
 *   只有在调用方已经确保子进程处于自成一组的场合才可以关闭它。
 */

/**
 * @typedef {object} StopOptions
 * @property {number} [gracefulTimeoutMs] 发出温和终止信号后等待的毫秒数
 * @property {number} [killTimeoutMs] 升级为强杀后等待的毫秒数
 * @property {number} [pollIntervalMs] 轮询进程是否消失的间隔
 * @property {(pid: number) => boolean} [isAlive] 存活探测实现，默认用信号 0 探测
 * @property {(target: number, signal: NodeJS.Signals) => void} [sendSignal] 发信号实现，
 *   默认对进程组发信号，失败时退回单进程
 */

/**
 * @typedef {object} SupervisedProcess
 * @property {string} id
 * @property {number} pid
 * @property {ProcessStatus} status
 * @property {string} command
 * @property {string[]} args
 * @property {string} cwd
 * @property {number} startedAt
 * @property {boolean} ownsProcessGroup 是否自成一个进程组（决定停止时能否对整组发信号）
 */

/**
 * 判断一个 pid 是否仍存在。
 *
 * 用信号 0 探测：进程存在但无权限时抛 EPERM，此时进程是活的；
 * 抛 ESRCH 表示进程已不存在。其他错误按"无法确认"处理，返回 true 更保守——
 * 谎报"已停止"比谎报"还在运行"更危险，前者会让用户重复启动。
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
    }
    return true;
  }
}

/**
 * 解析停止流程的时间参数。抽成纯函数以便单独验证边界。
 *
 * @param {{ gracefulTimeoutMs?: number, killTimeoutMs?: number, pollIntervalMs?: number }} [options]
 * @returns {{ gracefulTimeoutMs: number, killTimeoutMs: number, pollIntervalMs: number }}
 */
export function resolveStopTimings(options = {}) {
  /**
   * @param {unknown} value
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  const clamp = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
  };
  return {
    gracefulTimeoutMs: clamp(options.gracefulTimeoutMs, 5000, 100, 120_000),
    killTimeoutMs: clamp(options.killTimeoutMs, 3000, 100, 60_000),
    pollIntervalMs: clamp(options.pollIntervalMs, 100, 10, 2000),
  };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动一个受监管的进程。
 *
 * @param {StartOptions} options
 * @returns {Promise<SupervisedProcess>}
 */
export async function startSupervisedProcess(options) {
  const {
    id,
    command,
    args = [],
    cwd,
    env = {},
    onOutput,
    onExit,
    isolateProcessGroup = true,
  } = options;
  if (!id || typeof id !== 'string') throw new TypeError('id 必须是非空字符串');
  if (!command || typeof command !== 'string') throw new TypeError('command 必须是非空字符串');
  if (!cwd || typeof cwd !== 'string') throw new TypeError('cwd 必须是非空字符串');

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    // 自成进程组：调用方退出不影响它，停止时能回收整组。
    // 这一点很重要——如果子进程与调用方同组（例如某些测试运行器就是这样），
    // 对 -pid 发信号会打到调用方自己所在的进程组，把无关进程一并杀掉。
    detached: isolateProcessGroup,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  /** @type {SupervisedProcess} */
  const record = {
    id,
    pid: child.pid ?? -1,
    status: 'starting',
    command,
    args,
    cwd,
    startedAt: Date.now(),
    ownsProcessGroup: isolateProcessGroup,
  };

  // 让父进程的事件循环不因为这个子进程而被拖住
  child.unref();
  if (child.stdout) child.stdout.setEncoding('utf8');
  if (child.stderr) child.stderr.setEncoding('utf8');

  await new Promise((resolve, reject) => {
    /** @param {Error} error */
    const onError = (error) => {
      record.status = 'crashed';
      reject(error);
    };
    child.once('error', onError);
    child.once('spawn', () => {
      child.off('error', onError);
      record.status = 'running';
      onOutput?.('system', `已启动：${command} ${args.join(' ')}（pid ${record.pid}）\n`);
      resolve(undefined);
    });
  });

  child.stdout?.on('data', (chunk) => onOutput?.('stdout', String(chunk)));
  child.stderr?.on('data', (chunk) => onOutput?.('stderr', String(chunk)));

  child.once('exit', (code, signal) => {
    // 只有在不是我们自己请求停止时，才算异常退出
    if (record.status !== 'stopping') {
      record.status = 'crashed';
      onOutput?.('system', `进程异常退出：code=${code} signal=${signal}\n`);
    } else {
      record.status = 'stopped';
    }
    onExit?.(record.status, { code, signal });
  });

  return record;
}

/**
 * 停止一个受监管的进程：温和终止 → 确认 → 强杀 → 确认。
 *
 * 参数用最小结构类型而不是完整的 SupervisedProcess：这样调用方（与测试）可以传入
 * 任意满足这几个字段的对象，不必伪造整个记录。
 *
 * @param {{ pid: number, status: ProcessStatus, ownsProcessGroup?: boolean }} record
 * @param {StopOptions} [options]
 * @returns {Promise<{ stopped: boolean, escalated: boolean, reason: string }>}
 */
export async function stopSupervisedProcess(record, options = {}) {
  const { gracefulTimeoutMs, killTimeoutMs, pollIntervalMs } = resolveStopTimings(options);
  const isAlive = options.isAlive ?? isProcessAlive;
  const pid = record.pid;

  /**
   * 默认的发信号实现。
   *
   * 关键约束：只有当子进程确实自成一个进程组时才用 `-pid`。
   * 否则会把信号打到调用方所在的进程组，连带杀掉无关进程——
   * 这个错误在开发时几乎看不出来，直到某个测试跑起来莫名其妙地整组退出。
   *
   * @param {number} target
   * @param {NodeJS.Signals} signal
   */
  const defaultSendSignal = (target, signal) => {
    if (record.ownsProcessGroup) {
      try {
        process.kill(-target, signal);
        return;
      } catch {
        // 进程组不存在时退回单进程信号
      }
    }
    try {
      process.kill(target, signal);
    } catch {
      // 已经退出了
    }
  };

  const sendSignal = options.sendSignal ?? ((target, signal) => defaultSendSignal(target, signal));

  if (!isAlive(pid)) {
    record.status = 'stopped';
    return { stopped: true, escalated: false, reason: '进程已不存在' };
  }

  record.status = 'stopping';

  /**
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} 进程是否在超时内消失
   */
  const waitUntilGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await delay(pollIntervalMs);
    }
    return !isAlive(pid);
  };

  sendSignal(pid, 'SIGTERM');

  if (await waitUntilGone(gracefulTimeoutMs)) {
    record.status = 'stopped';
    return {
      stopped: true,
      escalated: false,
      reason: `SIGTERM 在 ${gracefulTimeoutMs}ms 内结束进程`,
    };
  }

  sendSignal(pid, 'SIGKILL');
  if (await waitUntilGone(killTimeoutMs)) {
    record.status = 'stopped';
    return {
      stopped: true,
      escalated: true,
      reason: `SIGTERM 超时，SIGKILL 在 ${killTimeoutMs}ms 内结束进程`,
    };
  }

  // 到这里说明进程无法回收。不谎报成功：状态标为 crashed，让用户去查。
  record.status = 'crashed';
  return {
    stopped: false,
    escalated: true,
    reason: `SIGKILL 后 ${killTimeoutMs}ms 进程 ${pid} 仍存在，状态不可信`,
  };
}
