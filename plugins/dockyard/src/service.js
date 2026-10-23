/**
 * dockyard 的服务层：把状态存储、项目扫描、进程监管与日志缓冲缝合成一组操作。
 *
 * 依赖全部由构造函数传入，因此这一层可以脱离 DSH 宿主单独测试——
 * 进程与日志的真实行为在 plugin-kit 里已经测过，这里测的是编排逻辑。
 *
 * 一条贯穿全文件的原则：**不谎报状态**。拿不到确凿证据时标为 unknown 并说明原因，
 * 而不是猜一个看起来更好的值。用户看到一个诚实的 unknown，比看到一个假的运行中要好。
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { flattenApps, scanProjects } from './project-scanner.js';
import {
  startSupervisedProcess,
  stopSupervisedProcess,
  isProcessAlive,
} from './internal/process-supervisor.js';
import { LogBuffer, readTail } from './internal/log-buffer.js';
import { StateStore } from './store.js';
import { sampleProcessGroup } from './metrics.js';
import { listExternalProcesses, terminateExternalProcess } from './processes.js';

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
   * @param {typeof scanProjects} [options.scanImpl] 可替换的扫描实现，便于测试。
   *   刻意不叫 scan：那会覆盖下面同名的类方法，把 scan() 静默变成递归调用。
   * @param {number} [options.metricsIntervalMs] CPU/内存采样间隔；0 表示不启动采样（测试用）。
   * @param {(pid: number) => Promise<import('./metrics.js').ProcessMetrics | null>} [options.sampleProcessImpl]
   *   可替换的采样实现，便于测试。
   * @param {typeof listExternalProcesses} [options.processLister] 可替换的外部进程枚举实现。
   * @param {typeof terminateExternalProcess} [options.terminateImpl] 可替换的进程终止实现。
   * @param {number} [options.syncIntervalMs] 周期同步间隔；0 表示关闭（测试用）。
   * @param {boolean} [options.syncOnStart] 启动后是否立即做一次同步。
   * @param {boolean} [options.autoTakeover] 发现已托管项目有外部进程时是否自动接管。
   * @param {number} [options.autoTakeoverIntervalMs] 自动接管轮询间隔。
   */
  constructor({
    dataDir,
    onWarn,
    scanImpl = scanProjects,
    metricsIntervalMs = 5000,
    sampleProcessImpl = sampleProcessGroup,
    processLister = listExternalProcesses,
    terminateImpl = terminateExternalProcess,
    syncIntervalMs = 5 * 60 * 1000,
    syncOnStart = true,
    autoTakeover = true,
    autoTakeoverIntervalMs = 60 * 1000,
  }) {
    this.dataDir = dataDir;
    this.logDir = join(dataDir, 'logs');
    this.onWarn = onWarn ?? (() => {});
    this.scanImpl = scanImpl;
    this.metricsIntervalMs = metricsIntervalMs;
    this.sampleProcessImpl = sampleProcessImpl;
    this.processLister = processLister;
    this.terminateImpl = terminateImpl;
    this.syncIntervalMs = syncIntervalMs;
    this.syncOnStart = syncOnStart;
    this.autoTakeover = autoTakeover;
    this.autoTakeoverIntervalMs = autoTakeoverIntervalMs;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.syncTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.syncInitialTimer = null;
    this.syncing = false;
    /** @type {null | { at: number, durationMs: number, projects: number, added: number, changed: number, missing: number, reappeared: number, errors: number }} */
    this.lastSync = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.autoTakeoverTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.autoTakeoverInitialTimer = null;
    this.autoTakingOver = false;
    /** @type {Map<string, number>} 失败后冷却到何时 */
    this.autoTakeoverCooldown = new Map();
    /** @type {null | { at: number, projectId: string, projectName: string, stoppedPids: number[], started: string[], reason: string }} */
    this.lastAutoTakeover = null;
    this.metricsDir = join(dataDir, 'metrics');
    /** @type {Map<string, import('./metrics.js').ProcessMetrics>} */
    this.metrics = new Map();
    /** @type {Map<string, { at: number, cpuPercent: number, rssBytes: number }[]>} */
    this.metricsHistory = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this.metricsTimer = null;
    this.metricsSampling = false;
    this.store = new StateStore(join(dataDir, 'state.json'));
    /** @type {Map<string, import('./internal/process-supervisor.js').SupervisedProcess>} */
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
    await mkdir(this.metricsDir, { recursive: true });
    this.#startMetrics();
    this.#startSync();
    this.#startAutoTakeover();
  }

  /** 启动周期同步。只同步已托管项目；定时器 unref，不阻止进程退出。 */
  #startSync() {
    if (this.syncIntervalMs <= 0) return;
    this.syncTimer = setInterval(() => {
      void this.syncProjects();
    }, this.syncIntervalMs);
    this.syncTimer.unref?.();
    if (this.syncOnStart) {
      this.syncInitialTimer = setTimeout(() => {
        void this.syncProjects();
      }, 3000);
      this.syncInitialTimer.unref?.();
    }
  }

  /** 停止周期同步。 */
  #stopSync() {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.syncInitialTimer !== null) {
      clearTimeout(this.syncInitialTimer);
      this.syncInitialTimer = null;
    }
  }

  /** 启动自动接管轮询。默认开启；发现已托管项目有外部服务进程时自动接管。 */
  #startAutoTakeover() {
    if (!this.autoTakeover || this.autoTakeoverIntervalMs <= 0) return;
    this.autoTakeoverTimer = setInterval(() => {
      void this.autoTakeoverOnce();
    }, this.autoTakeoverIntervalMs);
    this.autoTakeoverTimer.unref?.();
    this.autoTakeoverInitialTimer = setTimeout(() => {
      void this.autoTakeoverOnce();
    }, 8000);
    this.autoTakeoverInitialTimer.unref?.();
  }

  /** 停止自动接管轮询。 */
  #stopAutoTakeover() {
    if (this.autoTakeoverTimer !== null) {
      clearInterval(this.autoTakeoverTimer);
      this.autoTakeoverTimer = null;
    }
    if (this.autoTakeoverInitialTimer !== null) {
      clearTimeout(this.autoTakeoverInitialTimer);
      this.autoTakeoverInitialTimer = null;
    }
  }

  /**
   * 对已托管项目做一轮自动接管：发现 cwd 在项目根下的外部服务进程时，
   * 终止它们并按项目启动托管应用。默认开启；`autoTakeover: false` 可关闭。
   * 未托管项目不会自动加入，避免扫描目录后意外接管整台机器。
   * @returns {Promise<{ takenOver: number, skipped: number, errors: number }>}
   */
  async autoTakeoverOnce() {
    const summary = { takenOver: 0, skipped: 0, errors: 0 };
    if (!this.autoTakeover || this.autoTakingOver || this.syncing) return summary;
    this.autoTakingOver = true;
    try {
      const projects = new Map();
      for (const record of this.store.list()) {
        if (!record.projectId || !record.projectRoot) continue;
        if (!projects.has(record.projectId)) {
          projects.set(record.projectId, {
            id: record.projectId,
            name: record.projectName ?? record.projectId,
            root: record.projectRoot,
          });
        }
      }
      const allRoots = [...new Set([...projects.values()].map((project) => project.root))];
      const external = await this.externalProcesses(allRoots);
      if (external.error) {
        summary.errors += 1;
        return summary;
      }
      /** @type {Map<string, number>} */
      const externalCounts = new Map();
      // 自动接管只针对“正在监听端口”的外部服务，避免把 pnpm install / build 这类
      // 一次性命令误判成服务并杀掉。手动接管仍可处理没有端口的工作进程。
      for (const item of external.processes) {
        if (item.ports.length === 0) continue;
        externalCounts.set(item.root, (externalCounts.get(item.root) ?? 0) + 1);
      }
      for (const project of projects.values()) {
        const cooldown = this.autoTakeoverCooldown.get(project.id) ?? 0;
        if (Date.now() < cooldown) {
          summary.skipped += 1;
          continue;
        }
        if ((externalCounts.get(project.root) ?? 0) === 0) continue;
        const projectExternal = external.processes.filter((item) => item.root === project.root);
        const byPid = new Map(projectExternal.map((item) => [item.pid, item]));
        const onlyPids = new Set(
          projectExternal.filter((item) => item.ports.length > 0).map((item) => item.pid),
        );
        // 监听进程可能是 pnpm/turbo 的子进程；把项目内的祖先链一起停掉，
        // 避免父进程发现子进程退出后又把它拉起来。
        for (const pid of [...onlyPids]) {
          let cursor = byPid.get(pid)?.ppid ?? 0;
          for (let depth = 0; depth < 16 && cursor > 1; depth += 1) {
            if (!byPid.has(cursor)) break;
            onlyPids.add(cursor);
            cursor = byPid.get(cursor)?.ppid ?? 0;
          }
        }
        const result = await this.takeoverProjectFromScan(project.id, [project.root], {
          onlyPids: [...onlyPids],
        });
        if (result.takenOver) {
          summary.takenOver += 1;
          this.lastAutoTakeover = {
            at: Date.now(),
            projectId: project.id,
            projectName: project.name,
            stoppedPids: result.stoppedPids,
            started: result.started,
            reason: result.reason,
          };
        } else {
          summary.errors += 1;
          this.autoTakeoverCooldown.set(project.id, Date.now() + 10 * 60 * 1000);
          this.onWarn(`[dockyard] 自动接管 ${project.name} 失败：${result.reason}`);
        }
      }
      return summary;
    } finally {
      this.autoTakingOver = false;
    }
  }

  /**
   * 以磁盘事实为准，对已托管项目做一次结构同步：
   * - 新应用加入托管（不自动启动）；
   * - 启动命令变化时更新记录，旧参数压入 commandHistory，运行中的应用标记 restartRequired；
   * - 磁盘上消失的应用标记 missing，但记录、日志与历史全部保留；
   * - 重新出现的应用清除 missing。
   *
   * 这是“项目重构/切分支后自动适应”的唯一入口；不做静默删除。
   * @returns {Promise<{ at: number, durationMs: number, projects: number, added: number, changed: number, missing: number, reappeared: number, errors: number }>}
   */
  async syncProjects() {
    const startedAt = Date.now();
    const empty = {
      at: startedAt,
      durationMs: 0,
      projects: 0,
      added: 0,
      changed: 0,
      missing: 0,
      reappeared: 0,
      errors: 0,
    };
    if (this.syncing || this.autoTakingOver) return this.lastSync ?? empty;
    this.syncing = true;
    try {
      const records = this.store.list();
      /** @type {Map<string, { id: string, name: string, root: string, records: any[] }>} */
      const projects = new Map();
      for (const record of records) {
        if (!record.projectId || !record.projectRoot) continue;
        let project = projects.get(record.projectId);
        if (!project) {
          project = {
            id: record.projectId,
            name: record.projectName ?? record.projectId,
            root: record.projectRoot,
            records: [],
          };
          projects.set(record.projectId, project);
        }
        project.records.push(record);
      }

      let added = 0;
      let changed = 0;
      let missing = 0;
      let reappeared = 0;
      let errors = 0;
      const now = Date.now();

      for (const project of projects.values()) {
        let currentApps;
        try {
          const result = await this.scanImpl(project.root, {});
          currentApps = flattenApps(result.projects);
        } catch {
          errors += 1;
          continue;
        }
        const current = new Map(currentApps.map((app) => [app.id, app]));
        const existing = new Map(project.records.map((record) => [record.id, record]));

        for (const app of currentApps) {
          const record = existing.get(app.id);
          if (!record) {
            try {
              await this.add(/** @type {any} */ (app));
              added += 1;
              const created = this.store.get(app.id);
              if (created) {
                created.lastSeenAt = now;
                created.missing = false;
                created.missingAt = undefined;
              }
            } catch {
              errors += 1;
            }
            continue;
          }

          if (record.missing) {
            record.missing = false;
            record.missingAt = undefined;
            reappeared += 1;
          }
          record.lastSeenAt = now;
          const commandChanged =
            record.command !== app.command ||
            record.runner !== app.runner ||
            JSON.stringify(record.args ?? []) !== JSON.stringify(app.args ?? []);
          // npm/pnpm 的 args 永远只是 ["run","dev"]，脚本内容变化只体现在 reason 里。
          // 因此 reason 变化也必须视为启动命令变化，否则 package.json 重写会漏检。
          const reasonChanged = record.reason !== app.reason;
          if (commandChanged || reasonChanged) {
            const history = record.commandHistory ?? [];
            history.push({
              at: now,
              command: record.command,
              args: record.args ?? [],
              reason: record.reason ?? '',
            });
            record.commandHistory = history.slice(-10);
            if (commandChanged) {
              record.command = app.command;
              record.args = app.args;
              record.runner = app.runner;
            }
            record.reason = app.reason;
            record.ecosystemId = app.ecosystemId;
            record.ecosystemName = app.ecosystemName;
            record.language = app.language;
            record.manager = app.manager;
            changed += 1;
            if (record.status === 'running' || record.status === 'starting') {
              record.restartRequired = true;
              record.statusReason = '源码结构或启动命令已变化，重启后生效。';
            }
          }
          if (record.status !== 'running' && record.status !== 'starting') {
            record.restartRequired = false;
          }
        }

        for (const record of project.records) {
          if (current.has(record.id)) continue;
          if (!record.missing) {
            record.missing = true;
            record.missingAt = now;
            missing += 1;
          }
        }
      }

      await this.store.save();
      const summary = {
        at: now,
        durationMs: Date.now() - startedAt,
        projects: projects.size,
        added,
        changed,
        missing,
        reappeared,
        errors,
      };
      this.lastSync = summary;
      return summary;
    } finally {
      this.syncing = false;
    }
  }

  /** 启动周期采样。定时器 unref：测试或无人使用时不会阻止进程退出。 */
  #startMetrics() {
    if (this.metricsTimer !== null || this.metricsIntervalMs <= 0) return;
    this.metricsTimer = setInterval(() => {
      void this.sampleMetricsNow();
    }, this.metricsIntervalMs);
    this.metricsTimer.unref?.();
    void this.sampleMetricsNow();
  }

  /** 停止周期采样。 */
  #stopMetrics() {
    if (this.metricsTimer !== null) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  /** @param {string} id */
  #metricsFile(id) {
    return join(this.metricsDir, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  }

  /**
   * 追加一条采样到指标文件。文件超过 2MB 时轮转，避免长跑写满磁盘。
   * 采样是观测，不是核心状态：写盘失败只影响历史查询，不影响进程监管。
   * @param {string} id
   * @param {import('./metrics.js').ProcessMetrics} sample
   */
  async #appendMetric(id, sample) {
    const file = this.#metricsFile(id);
    try {
      const info = await stat(file);
      if (info.size > 2 * 1024 * 1024) {
        try {
          await rename(file, `${file}.1`);
        } catch {
          // 轮转失败就继续追加；宁可文件大一点，也不要丢采样
        }
      }
    } catch {
      // 文件还不存在
    }
    try {
      await appendFile(
        file,
        `${JSON.stringify({ at: sample.at, cpuPercent: sample.cpuPercent, rssBytes: sample.rssBytes })}
`,
        'utf8',
      );
    } catch {
      // 观测失败不向上抛
    }
  }

  /**
   * 对当前托管的全部进程组采样一次。重叠调用会跳过，避免慢 `ps` 堆叠。
   * @returns {Promise<void>}
   */
  async sampleMetricsNow() {
    if (this.metricsSampling) return;
    this.metricsSampling = true;
    try {
      for (const [id, handle] of this.processes) {
        const sample = await this.sampleProcessImpl(handle.pid);
        if (!sample) continue;
        this.metrics.set(id, sample);
        const history = this.metricsHistory.get(id) ?? [];
        history.push({
          at: sample.at,
          cpuPercent: sample.cpuPercent,
          rssBytes: sample.rssBytes,
        });
        if (history.length > 288) history.splice(0, history.length - 288);
        this.metricsHistory.set(id, history);
        await this.#appendMetric(id, sample);
      }
    } finally {
      this.metricsSampling = false;
    }
  }

  /**
   * 读取一个应用的指标历史（内存优先，文件兜底）。
   * @param {string} id
   * @param {number} [lines]
   * @returns {Promise<{ samples: { at: number, cpuPercent: number, rssBytes: number }[], source: 'memory'|'file'|'none' }>}
   */
  async getMetrics(id, lines = 60) {
    const history = this.metricsHistory.get(id) ?? [];
    if (history.length > 0) {
      return { samples: history.slice(-lines), source: 'memory' };
    }
    const file = this.#metricsFile(id);
    const raw = await readTail(file, { lines });
    /** @type {{ at: number, cpuPercent: number, rssBytes: number }[]} */
    const samples = [];
    for (const line of raw) {
      try {
        const parsed = JSON.parse(line);
        if (Number.isFinite(parsed.at) && Number.isFinite(parsed.cpuPercent)) {
          samples.push({
            at: Number(parsed.at),
            cpuPercent: Number(parsed.cpuPercent),
            rssBytes: Number(parsed.rssBytes) || 0,
          });
        }
      } catch {
        // 坏行跳过
      }
    }
    return { samples, source: samples.length > 0 ? 'file' : 'none' };
  }

  /**
   * 宿主系统概况，供仪表盘使用。
   */
  systemSnapshot() {
    return {
      totalmem: totalmem(),
      freemem: freemem(),
      cpus: cpus().length,
      loadavg: loadavg(),
      uptime: uptime(),
      platform: process.platform,
    };
  }

  /**
   * 输入框上方的状态条是否展示。
   *
   * 默认展示：旧状态文件没有 preferences 字段时也按 true 处理，
   * 这样升级插件不会悄悄改变用户已经看见的界面。
   * @returns {boolean}
   */
  get statusBarVisible() {
    return this.store.state.preferences?.statusBar !== false;
  }

  /**
   * 持久化状态条开关。面板与输入框上方的 dock 读同一份状态，
   * 因此刷新页面或重启宿主后选择仍然有效。
   * @param {boolean} visible
   * @returns {Promise<{ visible: boolean }>}
   */
  async setStatusBarVisible(visible) {
    if (typeof visible !== 'boolean') throw new TypeError('visible 必须是布尔值。');
    this.store.state.preferences = {
      ...(this.store.state.preferences ?? {}),
      statusBar: visible,
    };
    await this.store.save();
    return { visible: this.statusBarVisible };
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
   * 扫描一个或多个根目录，返回归一化后的项目树与诊断，并记下这些根目录。
   *
   * @param {string[]} roots
   * @param {{ maxDirs?: number }} [options]
   * @returns {Promise<{ projects: import('./project-scanner.js').Project[], diagnostics: import('./project-scanner.js').ScanDiagnostic[], scannedDirs: number }>}
   */
  async scan(roots, options = {}) {
    /** @type {import('./project-scanner.js').Project[]} */
    const projects = [];
    /** @type {import('./project-scanner.js').ScanDiagnostic[]} */
    const diagnostics = [];
    let scannedDirs = 0;

    for (const root of roots) {
      const result = await this.scanImpl(root, options);
      projects.push(...result.projects);
      diagnostics.push(...result.diagnostics);
      scannedDirs += result.scannedDirs;
    }

    // 已在托管列表里的应用要标出来，面板与工具都靠这个字段避免重复加入。
    for (const app of flattenApps(projects)) {
      app.alreadyAdded = Boolean(this.store.get(app.id));
    }

    for (const root of roots) {
      if (!this.store.state.scanRoots.includes(root)) this.store.state.scanRoots.push(root);
    }
    await this.store.save();

    return { projects, diagnostics, scannedDirs };
  }

  /**
   * 把候选应用加入管理列表。
   * @param {import('./project-scanner.js').RunnableApp} candidate
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
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      projectRoot: candidate.projectRoot,
      ecosystemId: candidate.ecosystemId,
      ecosystemName: candidate.ecosystemName,
      language: candidate.language,
      manager: candidate.manager,
      status: 'stopped',
      statusReason: '已加入管理列表，尚未启动。',
      logFile,
      addedAt: Date.now(),
    });
    await this.store.save();
    return { added: true, reason: '已加入管理列表。' };
  }

  /**
   * 重新扫描给定根目录，并把指定候选加入管理列表。
   *
   * 刻意重新扫描而不是信任调用方带回的候选描述：候选定义以**当前磁盘事实**为准，
   * 避免把一份已经过时的命令写进管理列表。工具与面板走同一条路径，行为不会分叉。
   *
   * @param {string} candidateId
   * @param {string[]} roots
   * @returns {Promise<{ added: boolean, reason: string }>}
   */
  async addFromScan(candidateId, roots) {
    const result = await this.scan(roots);
    const candidate = flattenApps(result.projects).find((item) => item.id === candidateId);
    if (!candidate) {
      return {
        added: false,
        reason: `没有找到 id 为 ${candidateId} 的候选应用，请重新扫描。`,
      };
    }
    return this.add(candidate);
  }

  /**
   * 把一个项目下的全部可运行应用加入托管。
   *
   * 托管的基本单位是项目，操作的最小单位是应用：这里一次把项目里的应用都登记好，
   * 后续启停仍然逐个应用进行。
   *
   * @param {import('./project-scanner.js').Project} project
   * @returns {Promise<{ added: boolean, projectId: string, appsAdded: number, skipped: number, reason: string }>}
   */
  async addProject(project) {
    const apps = flattenApps([project]);
    if (apps.length === 0) {
      return {
        added: false,
        projectId: project.id,
        appsAdded: 0,
        skipped: 0,
        reason: '项目没有可运行应用，未托管。',
      };
    }
    let appsAdded = 0;
    let skipped = 0;
    for (const app of apps) {
      const result = await this.add(app);
      if (result.added) appsAdded += 1;
      else skipped += 1;
    }
    return {
      added: appsAdded > 0,
      projectId: project.id,
      appsAdded,
      skipped,
      reason:
        appsAdded > 0
          ? `已托管 ${appsAdded} 个应用${skipped > 0 ? `（${skipped} 个已在列表中）` : ''}。`
          : '项目下的应用均已在托管列表中。',
    };
  }

  /**
   * 重新扫描后，把指定项目的全部应用加入托管。批量与单个走同一条路径。
   * @param {string[]} projectIds
   * @param {string[]} roots
   * @returns {Promise<{ added: boolean, projectIds: string[], appsAdded: number, skipped: number, missing: string[], reason: string }>}
   */
  async addProjectsFromScan(projectIds, roots) {
    const result = await this.scan(roots);
    const byId = new Map(result.projects.map((project) => [project.id, project]));
    const addedProjectIds = [];
    const missing = [];
    let appsAdded = 0;
    let skipped = 0;
    for (const projectId of projectIds) {
      const project = byId.get(projectId);
      if (!project) {
        missing.push(projectId);
        continue;
      }
      const added = await this.addProject(project);
      appsAdded += added.appsAdded;
      skipped += added.skipped;
      if (added.added || added.skipped > 0) addedProjectIds.push(projectId);
    }
    return {
      added: addedProjectIds.length > 0,
      projectIds: addedProjectIds,
      appsAdded,
      skipped,
      missing,
      reason:
        addedProjectIds.length > 0
          ? `已托管 ${addedProjectIds.length} 个项目、${appsAdded} 个应用${
              skipped > 0 ? `（${skipped} 个已在列表中）` : ''
            }。`
          : '没有可加入托管的项目。',
    };
  }

  /**
   * 从管理列表移除一个项目下的全部应用。运行中的应用必须先停止。
   * @param {string} projectId
   * @returns {Promise<{ removed: boolean, removedApps: number, reason: string }>}
   */
  async removeProject(projectId) {
    const records = this.store.list().filter((record) => record.projectId === projectId);
    if (records.length === 0) {
      return { removed: false, removedApps: 0, reason: '没有找到该项目的托管应用。' };
    }
    const running = records.filter(
      (record) => this.processes.has(record.id) || record.status === 'running',
    );
    if (running.length > 0) {
      return {
        removed: false,
        removedApps: 0,
        reason: `项目下有 ${running.length} 个应用在运行，请先停止再移除。`,
      };
    }
    for (const record of records) {
      this.store.remove(record.id);
      this.buffers.delete(record.id);
    }
    await this.store.save();
    return {
      removed: true,
      removedApps: records.length,
      reason: `已移除项目（${records.length} 个应用；日志文件保留）。`,
    };
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
    this.metrics.delete(id);
    this.metricsHistory.delete(id);
    await this.store.save();
    return { removed: true, reason: '已从管理列表移除（日志文件保留）。' };
  }

  /**
   * 列出全部应用，并补上"进程是否真的还在"这一层事实。
   *
   * 这里刻意不信任记录里的状态：记录说 running，但进程可能已经消失。
   * 以实际探测为准，并把发现写回记录，避免状态永久失真。
   *
   * @returns {Promise<{ id: string, name: string, dir: string, command: string, args: string[], status: string, statusReason: string, pid?: number, uptimeMs?: number, projectId?: string, projectName?: string, projectRoot?: string, ecosystemId?: string, ecosystemName?: string, language?: string, manager?: string, missing?: boolean, missingAt?: number, lastSeenAt?: number, restartRequired?: boolean, cpuPercent?: number, rssBytes?: number, processCount?: number, metricsAt?: number }[]>}
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
      const app = {
        id: record.id,
        name: record.name,
        dir: record.dir,
        command: record.command,
        args: record.args,
        status: record.status,
        statusReason: record.statusReason ?? '',
        cpuPercent:
          record.status === 'running' ? this.metrics.get(record.id)?.cpuPercent : undefined,
        rssBytes: record.status === 'running' ? this.metrics.get(record.id)?.rssBytes : undefined,
        processCount:
          record.status === 'running' ? this.metrics.get(record.id)?.processCount : undefined,
        metricsAt: record.status === 'running' ? this.metrics.get(record.id)?.at : undefined,
        projectId: record.projectId,
        projectName: record.projectName,
        projectRoot: record.projectRoot,
        ecosystemId: record.ecosystemId,
        ecosystemName: record.ecosystemName,
        language: record.language,
        manager: record.manager,
        missing: record.missing === true,
        missingAt: record.missingAt,
        lastSeenAt: record.lastSeenAt,
        restartRequired: record.restartRequired === true,
        pid: record.pid,
        uptimeMs:
          record.startedAt && record.status === 'running'
            ? Date.now() - record.startedAt
            : undefined,
      };
      // 工具输出必须是 lossless JSON；undefined 字段会让宿主校验失败。
      return /** @type {any} */ (
        Object.fromEntries(Object.entries(app).filter(([, value]) => value !== undefined))
      );
    });

    if (changed) await this.store.save();
    return out;
  }

  /**
   * 按项目聚合托管应用，供仪表盘与工具使用。
   * @returns {Promise<{ id: string, name: string, root: string, apps: number, running: number, missing: number, restartRequired: number, cpuPercent: number, rssBytes: number }[]>}
   */
  async listProjects() {
    const apps = await this.list();
    /** @type {Map<string, { id: string, name: string, root: string, apps: number, running: number, missing: number, restartRequired: number, cpuPercent: number, rssBytes: number }>} */
    const groups = new Map();
    for (const app of apps) {
      const key = app.projectId ?? 'unclassified';
      let group = groups.get(key);
      if (!group) {
        group = {
          id: key,
          name: app.projectName ?? '未归类',
          root: app.projectRoot ?? '',
          apps: 0,
          running: 0,
          missing: 0,
          restartRequired: 0,
          cpuPercent: 0,
          rssBytes: 0,
        };
        groups.set(key, group);
      }
      group.apps += 1;
      if (app.missing) group.missing += 1;
      if (app.restartRequired) group.restartRequired += 1;
      if (app.status === 'running') {
        group.running += 1;
        group.cpuPercent += app.cpuPercent ?? 0;
        group.rssBytes += app.rssBytes ?? 0;
      }
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        cpuPercent: Math.round(group.cpuPercent * 10) / 10,
      }))
      .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes);
  }

  /**
   * 枚举外部启动、但 cwd 在项目根目录下的进程。
   * @param {string[]} [roots] 不传时使用已托管项目的根目录
   * @returns {Promise<{ processes: import('./processes.js').ExternalProcess[], error: string }>}
   */
  async externalProcesses(roots) {
    const projectRoots =
      roots && roots.length > 0
        ? [...new Set(roots)]
        : /** @type {string[]} */ ([
            ...new Set(
              this.store
                .list()
                .map((record) => record.projectRoot)
                .filter(Boolean),
            ),
          ]);
    if (projectRoots.length === 0) return { processes: [], error: '' };
    const managedPids = [...this.processes.values()]
      .map((handle) => handle.pid)
      .filter((pid) => Number.isInteger(pid));
    const result = await this.processLister({ roots: projectRoots, managedPids });
    const projects = this.store.list();
    for (const item of result.processes) {
      const project = projects.find(
        (record) =>
          record.projectRoot === item.root || item.cwd.startsWith(`${record.projectRoot}/`),
      );
      if (project) {
        item.projectId = project.projectId;
        item.projectName = project.projectName;
      }
    }
    return result;
  }

  /**
   * 接管一个项目：终止 cwd 在项目根下的外部进程，再由 dockyard 托管并启动项目应用。
   * 必须先重新扫描，确保项目与启动命令仍是当前磁盘事实。
   * @param {string} projectId
   * @param {string[]} roots
   * @param {{ onlyPids?: number[] }} [options] 自动接管时只处理指定的监听进程 pid
   * @returns {Promise<{ takenOver: boolean, stoppedPids: number[], appsAdded: number, started: string[], failed: { id: string, reason: string }[], reason: string }>}
   */
  async takeoverProjectFromScan(projectId, roots, options = {}) {
    const scan = await this.scan(roots);
    const project = scan.projects.find((item) => item.id === projectId);
    if (!project) {
      return {
        takenOver: false,
        stoppedPids: [],
        appsAdded: 0,
        started: [],
        failed: [],
        reason: '项目已不在当前磁盘上，请重新扫描。',
      };
    }

    const external = await this.externalProcesses([project.root]);
    if (external.error) {
      return {
        takenOver: false,
        stoppedPids: [],
        appsAdded: 0,
        started: [],
        failed: [],
        reason: external.error,
      };
    }

    const stoppedPids = [];
    const failedToStop = [];
    const targets = options.onlyPids
      ? external.processes.filter((item) => options.onlyPids?.includes(item.pid))
      : external.processes;
    for (const item of targets) {
      const result = await this.terminateImpl(item, this.stopOptions ?? {});
      if (result.stopped) stoppedPids.push(item.pid);
      else failedToStop.push(`pid ${item.pid}`);
    }
    if (failedToStop.length > 0) {
      return {
        takenOver: false,
        stoppedPids,
        appsAdded: 0,
        started: [],
        failed: [],
        reason: `仍有外部进程未停止：${failedToStop.join('、')}；未启动托管应用，避免端口冲突。`,
      };
    }

    const added = await this.addProject(project);
    const started = [];
    const failed = [];
    for (const app of flattenApps([project])) {
      const record = this.store.get(app.id);
      if (record && (this.processes.has(app.id) || record.status === 'running')) {
        continue;
      }
      const result = await this.start(app.id);
      if (result.started) started.push(app.id);
      else failed.push({ id: app.id, reason: result.reason });
    }

    return {
      takenOver: true,
      stoppedPids,
      appsAdded: added.appsAdded,
      started,
      failed,
      reason:
        `已停止 ${stoppedPids.length} 个外部进程，托管 ${added.appsAdded} 个应用，启动 ${started.length} 个` +
        (failed.length > 0 ? `，${failed.length} 个启动失败。` : '。'),
    };
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
    this.#stopMetrics();
    this.#stopSync();
    this.#stopAutoTakeover();
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
