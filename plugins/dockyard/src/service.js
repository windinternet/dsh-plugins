/**
 * dockyard 的服务层：把状态存储、项目扫描、进程监管与日志缓冲缝合成一组操作。
 *
 * 依赖全部由构造函数传入，因此这一层可以脱离 DSH 宿主单独测试——
 * 进程与日志的真实行为在 plugin-kit 里已经测过，这里测的是编排逻辑。
 *
 * 一条贯穿全文件的原则：**不谎报状态**。拿不到确凿证据时标为 unknown 并说明原因，
 * 而不是猜一个看起来更好的值。用户看到一个诚实的 unknown，比看到一个假的运行中要好。
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  scanForApps,
  startSupervisedProcess,
  stopSupervisedProcess,
  isProcessAlive,
  LogBuffer,
  readTail,
} from '@dsh-plugins/plugin-kit';
import { StateStore } from './store.js';

/**
 * 由扫描结果推导出稳定的应用 id。
 * 用目录与启动方式而不是随机值，这样重复扫描同一项目不会产生重复条目。
 *
 * @param {{ dir: string, runner: string, scriptName?: string, args: string[] }} candidate
 * @returns {string}
 */
export function candidateId(candidate) {
  const key = candidate.scriptName ?? candidate.args.join(' ');
  return `${candidate.runner}:${candidate.dir}:${key}`;
}

/**
 * 把日志条目渲染成带流标记的纯文本行，供工具结果与面板显示。
 * @param {{ stream: string, at: number, text: string }[]} entries
 * @returns {string}
 */
export function renderLogLines(entries) {
  return entries
    .map((entry) => {
      const time = new Date(entry.at).toISOString().slice(11, 19);
      const tag = entry.stream === 'stderr' ? 'ERR' : entry.stream === 'system' ? 'SYS' : 'OUT';
      return `[${time}] ${tag} ${entry.text}`;
    })
    .join('\n');
}

export class DockyardService {
  /**
   * @param {object} options
   * @param {string} options.dataDir 插件数据目录（日志与状态文件都放在这里）
   * @param {(message: string) => void} [options.onWarn] 诊断回调
   * @param {typeof scanForApps} [options.scanImpl] 可替换的扫描实现，便于测试。
   *   刻意不叫 scan：那会覆盖下面同名的类方法，把 scan() 静默变成递归调用。
   */
  constructor({ dataDir, onWarn, scanImpl = scanForApps }) {
    this.dataDir = dataDir;
    this.logDir = join(dataDir, 'logs');
    this.onWarn = onWarn ?? (() => {});
    this.scanImpl = scanImpl;
    this.store = new StateStore(join(dataDir, 'state.json'));
    /** @type {Map<string, import('@dsh-plugins/plugin-kit/process').SupervisedProcess>} */
    this.processes = new Map();
    /** @type {Map<string, LogBuffer>} */
    this.buffers = new Map();
    /**
     * 停止进程时的时间参数。由宿主入口在创建后注入，缺省时用 plugin-kit 的默认值。
     * 显式声明这个字段，否则赋值会静默创建属性、而类型系统看不到它。
     * @type {{ gracefulTimeoutMs?: number, killTimeoutMs?: number } | undefined}
     */
    this.stopOptions = undefined;
  }

  /** 加载持久化状态。 */
  async init() {
    const { problems } = await this.store.load();
    for (const problem of problems) this.onWarn(problem);
    await mkdir(this.logDir, { recursive: true });
  }

  /**
   * 取得（必要时创建）某个应用的日志缓冲。
   * @param {string} appId
   * @param {string} logFile
   * @returns {LogBuffer}
   */
  #bufferFor(appId, logFile) {
    let buffer = this.buffers.get(appId);
    if (!buffer) {
      buffer = new LogBuffer({ file: logFile, maxEntries: 1000 });
      this.buffers.set(appId, buffer);
    }
    return buffer;
  }

  /**
   * 扫描一个或多个根目录，返回候选应用与诊断，并记下这些根目录。
   *
   * @param {string[]} roots
   * @param {{ maxDepth?: number }} [options]
   * @returns {Promise<{ candidates: { id: string, name: string, dir: string, runner: string, command: string, args: string[], reason: string, alreadyAdded: boolean }[], diagnostics: { path: string, message: string }[], scannedDirs: number }>}
   */
  async scan(roots, options = {}) {
    /** @type {any[]} */
    const candidates = [];
    /** @type {any[]} */
    const diagnostics = [];
    let scannedDirs = 0;

    for (const root of roots) {
      const result = await this.scanImpl(root, { maxDepth: options.maxDepth });
      scannedDirs += result.scannedDirs;
      diagnostics.push(...result.diagnostics);
      for (const app of result.apps) {
        const id = candidateId(app);
        candidates.push({
          id,
          name: app.name,
          dir: app.dir,
          runner: app.runner,
          command: app.command,
          args: app.args,
          reason: app.reason,
          alreadyAdded: Boolean(this.store.get(id)),
        });
      }
    }

    for (const root of roots) {
      if (!this.store.state.scanRoots.includes(root)) this.store.state.scanRoots.push(root);
    }
    await this.store.save();

    return { candidates, diagnostics, scannedDirs };
  }

  /**
   * 把候选应用加入管理列表。
   * @param {{ id: string, name: string, dir: string, runner: 'node'|'python'|'shell', command: string, args: string[], reason: string }} candidate
   * @returns {Promise<{ added: boolean, reason: string }>}
   */
  async add(candidate) {
    if (this.store.get(candidate.id)) {
      return { added: false, reason: '该应用已在管理列表中。' };
    }
    const logFile = join(this.logDir, `${candidate.id.replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
    this.store.put({
      id: candidate.id,
      name: candidate.name,
      dir: candidate.dir,
      runner: candidate.runner,
      command: candidate.command,
      args: candidate.args,
      reason: candidate.reason,
      status: 'stopped',
      statusReason: '已加入管理列表，尚未启动。',
      logFile,
      addedAt: Date.now(),
    });
    await this.store.save();
    return { added: true, reason: '已加入管理列表。' };
  }

  /**
   * 从管理列表移除。运行中的应用必须先停止，避免留下无人认领的进程。
   * @param {string} id
   * @returns {Promise<{ removed: boolean, reason: string }>}
   */
  async remove(id) {
    const record = this.store.get(id);
    if (!record) return { removed: false, reason: `没有 id 为 ${id} 的应用。` };
    if (this.processes.has(id) || record.status === 'running') {
      return { removed: false, reason: '应用处于运行状态，请先停止再移除。' };
    }
    this.store.remove(id);
    this.buffers.delete(id);
    await this.store.save();
    return { removed: true, reason: '已从管理列表移除（日志文件保留）。' };
  }

  /**
   * 列出全部应用，并补上"进程是否真的还在"这一层事实。
   *
   * 这里刻意不信任记录里的状态：记录说 running，但进程可能已经消失。
   * 以实际探测为准，并把发现写回记录，避免状态永久失真。
   *
   * @returns {Promise<{ id: string, name: string, dir: string, command: string, args: string[], status: string, statusReason: string, pid?: number, uptimeMs?: number }[]>}
   */
  async list() {
    const records = this.store.list();
    let changed = false;

    const out = records.map((record) => {
      const handle = this.processes.get(record.id);
      if (record.status === 'running' && handle) {
        if (!isProcessAlive(handle.pid)) {
          record.status = 'crashed';
          record.statusReason = '进程已消失，但未收到退出通知，状态由探测更正。';
          record.pid = undefined;
          changed = true;
        }
      }
      return {
        id: record.id,
        name: record.name,
        dir: record.dir,
        command: record.command,
        args: record.args,
        status: record.status,
        statusReason: record.statusReason ?? '',
        pid: record.pid,
        uptimeMs:
          record.startedAt && record.status === 'running'
            ? Date.now() - record.startedAt
            : undefined,
      };
    });

    if (changed) await this.store.save();
    return out;
  }

  /**
   * 启动一个应用。
   * @param {string} id
   * @returns {Promise<{ started: boolean, reason: string, pid?: number }>}
   */
  async start(id) {
    const record = this.store.get(id);
    if (!record) return { started: false, reason: `没有 id 为 ${id} 的应用。` };

    if (this.processes.has(id)) {
      const handle = this.processes.get(id);
      if (handle && isProcessAlive(handle.pid)) {
        return { started: false, reason: `应用已在运行（pid ${handle.pid}）。` };
      }
      this.processes.delete(id);
    }

    record.status = 'starting';
    record.statusReason = '正在启动。';
    await this.store.save();

    const buffer = this.#bufferFor(id, record.logFile);
    try {
      const handle = await startSupervisedProcess({
        id,
        command: record.command,
        args: record.args,
        cwd: record.dir,
        onOutput: (stream, text) => buffer.append(stream, text),
        onExit: (status, detail) => {
          const current = this.store.get(id);
          if (!current) return;
          current.status = status === 'stopped' ? 'stopped' : 'crashed';
          current.statusReason =
            status === 'stopped'
              ? '进程已停止。'
              : `进程异常退出（code=${detail.code} signal=${detail.signal}）。`;
          current.stoppedAt = Date.now();
          current.exitCode = detail.code ?? undefined;
          current.pid = undefined;
          this.processes.delete(id);
          void this.store.save();
        },
      });

      this.processes.set(id, handle);
      record.status = 'running';
      record.statusReason = '进程已启动。';
      record.pid = handle.pid;
      record.startedAt = Date.now();
      record.stoppedAt = undefined;
      record.exitCode = undefined;
      await this.store.save();
      return { started: true, reason: `已启动（pid ${handle.pid}）。`, pid: handle.pid };
    } catch (error) {
      record.status = 'crashed';
      record.statusReason = `启动失败：${error instanceof Error ? error.message : String(error)}`;
      record.pid = undefined;
      await this.store.save();
      return { started: false, reason: record.statusReason };
    }
  }

  /**
   * 停止一个应用。
   * @param {string} id
   * @returns {Promise<{ stopped: boolean, reason: string }>}
   */
  async stop(id) {
    const record = this.store.get(id);
    if (!record) return { stopped: false, reason: `没有 id 为 ${id} 的应用。` };

    const handle = this.processes.get(id);
    if (!handle) {
      // 没有句柄：可能是宿主重启后遗留的 unknown，或本来就没启动。
      if (record.status === 'unknown') {
        record.status = 'stopped';
        record.statusReason = '用户确认标记为已停止（本插件无法回收非本进程启动的进程）。';
        await this.store.save();
        return { stopped: true, reason: record.statusReason };
      }
      record.status = 'stopped';
      record.statusReason = '应用未在运行。';
      await this.store.save();
      return { stopped: true, reason: '应用未在运行。' };
    }

    const result = await stopSupervisedProcess(handle, this.stopOptions ?? {});
    if (result.stopped) {
      record.status = 'stopped';
      record.statusReason = result.reason;
      record.stoppedAt = Date.now();
      record.pid = undefined;
      this.processes.delete(id);
    } else {
      record.status = 'crashed';
      record.statusReason = result.reason;
    }
    await this.store.save();
    return { stopped: result.stopped, reason: result.reason };
  }

  /**
   * 重启：先停（若在运行），再启。
   * @param {string} id
   * @returns {Promise<{ restarted: boolean, reason: string }>}
   */
  async restart(id) {
    const stopResult = await this.stop(id);
    if (!stopResult.stopped) {
      return { restarted: false, reason: `停止阶段失败，未执行启动：${stopResult.reason}` };
    }
    const startResult = await this.start(id);
    return { restarted: startResult.started, reason: startResult.reason };
  }

  /**
   * 读取某个应用的最近日志。
   *
   * 优先读内存缓冲（快、含 system 事件）；缓冲为空时退回读文件尾部
   * （例如宿主刚重启，历史日志只在文件里）。
   *
   * @param {string} id
   * @param {number} [lines]
   * @returns {Promise<{ lines: string[], source: 'buffer'|'file'|'none' }>}
   */
  async logs(id, lines = 100) {
    const record = this.store.get(id);
    if (!record) return { lines: [`没有 id 为 ${id} 的应用。`], source: 'none' };

    const buffer = this.buffers.get(id);
    const buffered = buffer ? buffer.tail(lines) : [];
    if (buffered.length > 0) {
      return { lines: renderLogLines(buffered).split('\n'), source: 'buffer' };
    }
    if (record.logFile) {
      const fromFile = await readTail(record.logFile, { lines });
      if (fromFile.length > 0) return { lines: fromFile, source: 'file' };
    }
    return { lines: [], source: 'none' };
  }

  /**
   * 等待所有挂起的日志写盘完成。
   *
   * 存在的理由：日志是异步追加的，进程刚退出时文件里可能还没有最后几行。
   * 测试与卸载流程需要这个点来消除竞态，而不是靠 sleep 猜时间。
   * @returns {Promise<void>}
   */
  async flushLogs() {
    for (const buffer of this.buffers.values()) await buffer.flush();
  }

  /**
   * 插件卸载时的收尾。
   *
   * 默认**不**杀死被托管的进程：dockyard 的价值之一就是进程不随客户端消失。
   * 但必须把这一点记进日志并把状态标为 unknown，否则下次读到"运行中"就是谎言。
   *
   * @param {{ killProcesses?: boolean }} [options]
   * @returns {Promise<{ killed: number, leftRunning: number }>}
   */
  async shutdown(options = {}) {
    for (const buffer of this.buffers.values()) await buffer.flush();

    if (options.killProcesses) {
      let killed = 0;
      for (const [id, handle] of [...this.processes.entries()]) {
        const result = await stopSupervisedProcess(handle, this.stopOptions ?? {});
        if (result.stopped) killed += 1;
        const record = this.store.get(id);
        if (record) {
          record.status = 'stopped';
          record.statusReason = '插件卸载时按要求停止了进程。';
          record.stoppedAt = Date.now();
          record.pid = undefined;
        }
      }
      this.processes.clear();
      await this.store.save();
      return { killed, leftRunning: 0 };
    }

    const leftRunning = this.processes.size;
    for (const id of this.processes.keys()) {
      const record = this.store.get(id);
      if (!record) continue;
      record.status = 'unknown';
      record.statusReason = '插件已卸载，本插件不再持有该进程的句柄，无法确认其是否仍在运行。';
      record.pid = undefined;
    }
    this.processes.clear();
    await this.store.save();
    return { killed: 0, leftRunning };
  }
}
