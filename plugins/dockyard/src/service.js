/**
 * dockyard 的服务层：把状态存储、项目扫描、进程监管与日志缓冲缝合成一组操作。
 *
 * 依赖全部由构造函数传入，因此这一层可以脱离 DSH 宿主单独测试——
 * 进程与日志的真实行为在 plugin-kit 里已经测过，这里测的是编排逻辑。
 *
 * 一条贯穿全文件的原则：**不谎报状态**。拿不到确凿证据时标为 unknown 并说明原因，
 * 而不是猜一个看起来更好的值。用户看到一个诚实的 unknown，比看到一个假的运行中要好。
 */

import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { flattenApps, scanProjects } from './project-scanner.js';
import { matchExternalApps, collectStopProcesses } from './external-apps.js';
import {
  startSupervisedProcess,
  stopSupervisedProcess,
  isProcessAlive,
} from './internal/process-supervisor.js';
import { readTail } from './internal/log-buffer.js';
import { StateStore, defaultGuardPolicy } from './store.js';
import { sampleProcessGroup } from './metrics.js';
import {
  inspectProcess,
  listExternalProcesses,
  listListeningPorts,
  terminateExternalProcess,
} from './processes.js';

/** 独立启动器：应用由它托管，DSH/插件退出后它继续运行。 */
const APP_LAUNCHER = fileURLToPath(new URL('./internal/app-launcher.mjs', import.meta.url));

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
   * @param {typeof listListeningPorts} [options.portLister] 可替换的监听端口枚举实现。
   * @param {typeof inspectProcess} [options.processInspector] 可替换的进程检查实现。
   * @param {typeof terminateExternalProcess} [options.terminateImpl] 可替换的进程终止实现。
   * @param {number} [options.syncIntervalMs] 周期同步间隔；0 表示关闭（测试用）。
   * @param {boolean} [options.syncOnStart] 启动后是否立即做一次同步。
   */
  constructor({
    dataDir,
    onWarn,
    scanImpl = scanProjects,
    metricsIntervalMs = 5000,
    sampleProcessImpl = sampleProcessGroup,
    processLister = listExternalProcesses,
    portLister = listListeningPorts,
    processInspector = inspectProcess,
    terminateImpl = terminateExternalProcess,
    syncIntervalMs = 5 * 60 * 1000,
    syncOnStart = true,
  }) {
    this.dataDir = dataDir;
    this.logDir = join(dataDir, 'logs');
    this.runtimeDir = join(dataDir, 'runtime');
    this.onWarn = onWarn ?? (() => {});
    this.scanImpl = scanImpl;
    this.metricsIntervalMs = metricsIntervalMs;
    this.sampleProcessImpl = sampleProcessImpl;
    this.processLister = processLister;
    this.portLister = portLister;
    this.processInspector = processInspector;
    this.terminateImpl = terminateImpl;
    this.syncIntervalMs = syncIntervalMs;
    this.syncOnStart = syncOnStart;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.syncTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.syncInitialTimer = null;
    this.syncing = false;
    /** @type {null | { at: number, durationMs: number, projects: number, added: number, changed: number, missing: number, reappeared: number, errors: number }} */
    this.lastSync = null;
    this.metricsDir = join(dataDir, 'metrics');
    /** @type {Map<string, import('./metrics.js').ProcessMetrics>} */
    this.metrics = new Map();
    /** @type {Map<string, { at: number, cpuPercent: number, rssBytes: number }[]>} */
    this.metricsHistory = new Map();
    /**
     * 按采样周期聚合的资源总量，供概览的趋势图使用。
     * 只保留最近 288 个点（默认 5 秒采样约 24 分钟），不落盘：
     * 它是观测快照，不是业务状态，重启后从空开始比恢复一份过期数据更诚实。
     * @type {{ at: number, cpuPercent: number, rssBytes: number, apps: number }[]}
     */
    this.resourceHistory = [];
    /**
     * 外部进程 → 已托管应用的匹配结果缓存。状态接口每 5 秒被轮询一次，
     * 每次 ps + lsof 没有必要；4 秒内的重复查询复用同一份结果。
     * @type {null | { at: number, value: { apps: any[], unmatched: number, error: string } }}
     */
    this.externalAppsCache = null;
    /** @type {{ at: number, groups: Map<number, number[]>, error: string }} 监听端口缓存 */
    this.portCache = { at: 0, groups: new Map(), error: '' };
    /** @type {Map<string, ReturnType<typeof setTimeout>>} 守护重试定时器 */
    this.guardTimers = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this.metricsTimer = null;
    this.metricsSampling = false;
    this.store = new StateStore(join(dataDir, 'state.json'));
    /** @type {Map<string, import('./internal/process-supervisor.js').SupervisedProcess>} */
    this.processes = new Map();
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
    await mkdir(this.runtimeDir, { recursive: true });
    await this.#reattachManagedProcesses();
    this.#startMetrics();
    this.#startSync();
  }

  /** @param {string} id */
  #runtimePath(id) {
    const digest = createHash('sha256').update(id).digest('hex').slice(0, 32);
    return join(this.runtimeDir, `${digest}.json`);
  }

  /**
   * 读取全部运行时记录。它们是 pid + 日志文件 + 进程身份的第二份存盘凭据，
   * 即使 state.json 里的 pid 被旧版本清掉，也还能靠它接回进程。
   * @returns {Promise<Map<string, any>>}
   */
  async #readRuntimeRecords() {
    /** @type {Map<string, any>} */
    const records = new Map();
    let names = [];
    try {
      names = await readdir(this.runtimeDir);
    } catch {
      return records;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(join(this.runtimeDir, name), 'utf8'));
        if (raw && typeof raw.appId === 'string' && Number.isInteger(raw.pid)) {
          records.set(raw.appId, raw);
        }
      } catch {
        // 坏文件不影响其他应用。
      }
    }
    return records;
  }

  /**
   * @param {any} record
   * @param {number} pid
   */
  async #writeRuntimeRecord(record, pid) {
    const info = /** @type {any} */ (
      await this.processInspector(pid).catch(() => ({ alive: false }))
    );
    const payload = {
      appId: record.id,
      pid,
      startedAt: record.startedAt ?? Date.now(),
      logFile: record.logFile,
      command: record.command,
      args: record.args,
      processCommand: info.command,
      executable: info.comm,
      processStartedAt: info.startedAtText,
    };
    try {
      await mkdir(this.runtimeDir, { recursive: true });
      const file = this.#runtimePath(record.id);
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
      await rename(temp, file);
    } catch {
      // 运行时记录写失败不阻塞启动；state.json 里的 pid 仍可用。
    }
  }

  /** @param {string} id */
  async #removeRuntimeRecord(id) {
    try {
      await unlink(this.#runtimePath(id));
    } catch {
      // 不存在或已删除都算完成。
    }
  }

  /**
   * 判断 runtime 记录和当前 pid 是否指向同一个进程。
   * 优先比较 ps lstart（pid 复用后启动时间一定不同），其次比较完整命令行。
   * @param {any} runtime
   * @param {{ command?: string, startedAtText?: string }} info
   * @param {number} pid
   */
  #runtimeMatches(runtime, info, pid) {
    if (!runtime || runtime.pid !== pid) return false;
    if (runtime.processStartedAt && info.startedAtText) {
      return runtime.processStartedAt === info.startedAtText;
    }
    if (runtime.processCommand && info.command) {
      return runtime.processCommand === info.command;
    }
    return false;
  }

  /**
   * 宿主重启后，根据状态里的 pid 重新认领仍在运行的启动器。
   *
   * 优先读 runtime 记录，用启动时间/命令行核对同一进程；没有 runtime 时退回
   * app-launcher.mjs + 进程组校验。这样既能把仍活着的托管应用接回来，也不会把
   * pid 复用后的陌生进程误认成自己的。认领失败时如实降级，绝不自动启动。
   * @returns {Promise<number>} 重新接管的数量
   */
  async #reattachManagedProcesses() {
    const runtimes = await this.#readRuntimeRecords();
    let changed = false;
    let reattached = 0;
    for (const record of this.store.list()) {
      if (record.status === 'stopped') continue;
      const runtime = runtimes.get(record.id);
      const pid = runtime?.pid ?? record.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) continue;
      const info = await this.processInspector(pid);
      if (!info.alive) {
        record.status = 'crashed';
        record.statusReason = '宿主重启后发现进程已退出，未自动启动。';
        record.pid = undefined;
        record.stoppedAt = Date.now();
        if (record.guard?.active) {
          this.#deactivateGuard(record, '宿主重启后发现进程已退出，守护暂停，未自动启动。');
        }
        await this.#removeRuntimeRecord(record.id);
        changed = true;
        continue;
      }

      const identityMatches = this.#runtimeMatches(runtime, info, pid);
      const launcherMatches =
        typeof info.command === 'string' &&
        info.command.includes('app-launcher.mjs') &&
        info.pgid === pid;
      if (!identityMatches && !launcherMatches) {
        record.status = 'unknown';
        record.statusReason = '进程仍存在，但身份与运行时记录不符，未重新接管。';
        record.pid = undefined;
        if (record.guard?.active) {
          this.#deactivateGuard(record, '未能确认原启动器，守护暂停，未自动启动。');
        }
        await this.#removeRuntimeRecord(record.id);
        changed = true;
        continue;
      }

      if (runtime?.logFile && typeof runtime.logFile === 'string') {
        record.logFile = runtime.logFile;
      }
      /** @type {any} */
      const handle = {
        id: record.id,
        pid,
        status: 'running',
        command: record.command,
        args: record.args,
        cwd: record.dir,
        startedAt: record.startedAt ?? runtime?.startedAt ?? Date.now(),
        ownsProcessGroup: true,
      };
      this.processes.set(record.id, handle);
      record.status = 'running';
      record.pid = pid;
      record.statusReason = `宿主重启后已重新接管（pid ${pid}）。`;
      if (record.guard?.active) {
        record.guard.nextAttemptAt = undefined;
        record.guard.reason = '宿主重启后已重新接管，守护继续。';
      }
      reattached += 1;
      changed = true;
      await this.#writeRuntimeRecord(record, pid);
      await this.#appendSystemLog(record.logFile, record.statusReason);
    }

    const known = new Set(this.store.list().map((record) => record.id));
    for (const id of runtimes.keys()) {
      if (!known.has(id)) await this.#removeRuntimeRecord(id);
    }
    if (changed) await this.store.save();
    return reattached;
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
    if (this.syncing) return this.lastSync ?? empty;
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
            if (record.guard?.active) {
              this.#deactivateGuard(record, '应用已失联，守护暂停。');
            }
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
    let sampled = 0;
    try {
      for (const [id, handle] of this.processes) {
        const sample = await this.sampleProcessImpl(handle.pid);
        if (!sample) continue;
        sampled += 1;
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
      // 只有本轮真的采到样本才追加聚合点，避免把上一轮的旧值当成新趋势。
      if (sampled > 0) {
        let cpuPercent = 0;
        let rssBytes = 0;
        let apps = 0;
        for (const id of this.processes.keys()) {
          const sample = this.metrics.get(id);
          if (!sample) continue;
          cpuPercent += sample.cpuPercent;
          rssBytes += sample.rssBytes;
          apps += 1;
        }
        this.resourceHistory.push({
          at: Date.now(),
          cpuPercent: Math.round(cpuPercent * 10) / 10,
          rssBytes,
          apps,
        });
        if (this.resourceHistory.length > 288) {
          this.resourceHistory.splice(0, this.resourceHistory.length - 288);
        }
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
   * 追加一条 dockyard 自身的系统日志。子进程输出直接写同一个文件，
   * 这里只补启动/停止/退出这类事件，保证日志里能看到控制动作。
   * @param {string | undefined} logFile
   * @param {string} text
   * @returns {Promise<void>}
   */
  async #appendSystemLog(logFile, text) {
    if (!logFile) return;
    try {
      await appendFile(logFile, `[${new Date().toISOString()}] SYS ${text}\n`, 'utf8');
    } catch {
      // 日志是观测，不是核心状态；写失败不影响启停。
    }
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
      this.#clearGuardTimer(record.id);
      await this.#removeRuntimeRecord(record.id);
      this.store.remove(record.id);
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
    this.#clearGuardTimer(id);
    await this.#removeRuntimeRecord(id);
    this.store.remove(id);
    this.metrics.delete(id);
    this.metricsHistory.delete(id);
    await this.store.save();
    return { removed: true, reason: '已从管理列表移除（日志文件保留）。' };
  }

  /**
   * 刷新托管应用的监听端口缓存。按进程组聚合，一次 ps + lsof 覆盖全部应用。
   * @returns {Promise<{ at: number, groups: Map<number, number[]>, error: string }>}
   */
  async #refreshAppPorts() {
    const now = Date.now();
    if (now - this.portCache.at < 3000) return this.portCache;
    try {
      const result = await this.portLister();
      this.portCache = {
        at: Date.now(),
        groups: result.groups instanceof Map ? result.groups : new Map(),
        error: result.error ?? '',
      };
    } catch (error) {
      this.portCache = {
        at: Date.now(),
        groups: new Map(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return this.portCache;
  }

  /**
   * 记住某个应用偏好的访问端口；只影响访问按钮，不影响进程。
   * @param {string} id
   * @param {number} port
   * @returns {Promise<{ id: string, port: number }>}
   */
  async setAppPreferredPort(id, port) {
    if (!this.store.get(id)) throw new TypeError(`没有 id 为 ${id} 的应用。`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('port 必须是 1..65535 之间的整数。');
    }
    this.store.state.appPorts ??= {};
    this.store.state.appPorts[id] = port;
    await this.store.save();
    return { id, port };
  }

  /**
   * 列出全部应用，并补上"进程是否真的还在"这一层事实。
   *
   * 这里刻意不信任记录里的状态：记录说 running，但进程可能已经消失。
   * 以实际探测为准，并把发现写回记录，避免状态永久失真。
   *
   * @returns {Promise<{ id: string, name: string, dir: string, command: string, args: string[], status: string, statusReason: string, pid?: number, uptimeMs?: number, projectId?: string, projectName?: string, projectRoot?: string, ecosystemId?: string, ecosystemName?: string, language?: string, manager?: string, missing?: boolean, missingAt?: number, lastSeenAt?: number, restartRequired?: boolean, cpuPercent?: number, rssBytes?: number, processCount?: number, metricsAt?: number, ports?: number[], preferredPort?: number }[]>}
   */
  async list() {
    const records = this.store.list();
    const hasHandles = records.some((record) => this.processes.has(record.id));
    if (hasHandles) await this.#refreshAppPorts();
    let changed = false;

    const out = records.map((record) => {
      const handle = this.processes.get(record.id);
      if (record.status === 'running' && handle) {
        if (!isProcessAlive(handle.pid)) {
          record.status = 'crashed';
          record.statusReason = '进程已消失，但未收到退出通知，状态由探测更正。';
          record.pid = undefined;
          changed = true;
          this.#scheduleGuardRetry(record.id);
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
        ports: handle ? (this.portCache.groups.get(handle.pid) ?? []) : [],
        preferredPort: this.store.state.appPorts?.[record.id],
        guard: record.guard,
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
   * 列出"外部启动、但能匹配回已托管应用"的进程，以及匹配不到的外部进程数量。
   * 这里只做观测，不终止、不启动任何东西。
   * @param {{ fresh?: boolean }} [options] fresh=true 时跳过 4 秒缓存
   * @returns {Promise<{ apps: any[], unmatched: number, error: string }>}
   */
  async listExternalApps(options = {}) {
    const now = Date.now();
    if (
      !options.fresh &&
      this.externalAppsCache !== null &&
      now - this.externalAppsCache.at < 4000
    ) {
      return this.externalAppsCache.value;
    }

    const records = this.store
      .list()
      .filter((record) => Boolean(record.projectRoot) && record.missing !== true);
    const roots = [...new Set(records.map((record) => record.projectRoot))].filter(
      (root) => typeof root === 'string',
    );
    if (roots.length === 0) {
      const value = { apps: [], unmatched: 0, error: '' };
      this.externalAppsCache = { at: now, value };
      return value;
    }

    // 除了当前进程句柄，也把状态里仍标记为运行/启动/停止中的 pid 算进来。
    // 插件热重载后 in-memory 句柄可能丢失，但这些 pid 仍是我们启动的启动器；
    // 不排除它们就会把同一个应用树误判成外部进程（托管/非托管来回跳）。
    const managedPids = new Set();
    for (const handle of this.processes.values()) {
      if (Number.isInteger(handle.pid)) managedPids.add(handle.pid);
    }
    for (const record of this.store.list()) {
      if (
        Number.isInteger(record.pid) &&
        (record.status === 'running' ||
          record.status === 'starting' ||
          record.status === 'stopping')
      ) {
        managedPids.add(record.pid);
      }
    }
    const result = await this.processLister({ roots, managedPids: [...managedPids] });
    if (result.error) {
      const value = { apps: [], unmatched: 0, error: result.error };
      this.externalAppsCache = { at: now, value };
      return value;
    }

    const matched = matchExternalApps(records, result.processes);
    const apps = matched.apps.map((app) => ({
      ...app,
      preferredPort: this.store.state.appPorts?.[app.id],
      stopProcesses: collectStopProcesses(app.processes, result.processes, app.projectRoot),
    }));
    const value = { apps, unmatched: matched.unmatched.length, error: '' };
    this.externalAppsCache = { at: now, value };
    return value;
  }

  /**
   * 手动接管一组应用：只终止匹配到这些应用的外部进程，再把对应应用交给 dockyard 启动。
   * 接管单位是应用，不会因为同项目里还有别的应用就顺带启动它们。
   * @param {string[]} ids
   * @returns {Promise<{ takenOver: number, stoppedPids: number[], started: string[], failed: { id: string, reason: string }[], skipped: { id: string, reason: string }[], reason: string }>}
   */
  async takeoverApps(ids) {
    const requested = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
    const empty = {
      takenOver: 0,
      stoppedPids: [],
      started: [],
      failed: [],
      skipped: [],
      reason: '没有指定要接管的应用。',
    };
    if (requested.length === 0) return empty;

    const external = await this.listExternalApps({ fresh: true });
    const byId = new Map(external.apps.map((app) => [app.id, app]));
    const stoppedPids = [];
    const stopped = new Set();
    const started = [];
    const failed = [];
    const skipped = [];

    for (const id of requested) {
      const target = byId.get(id);
      if (!target) {
        skipped.push({ id, reason: '没有发现该应用的外部进程。' });
        continue;
      }
      if (this.processes.has(id)) {
        skipped.push({ id, reason: '应用已在 dockyard 托管中。' });
        continue;
      }

      let stoppedOk = true;
      for (const process of target.stopProcesses ?? []) {
        if (stopped.has(process.pid)) continue;
        const result = await this.terminateImpl(process, this.stopOptions ?? {});
        if (result.stopped) {
          stopped.add(process.pid);
          stoppedPids.push(process.pid);
        } else {
          stoppedOk = false;
          failed.push({
            id,
            reason: `外部进程 ${process.pid} 未能停止：${result.reason}`,
          });
          break;
        }
      }
      if (!stoppedOk) continue;

      const startedResult = await this.start(id);
      if (startedResult.started) started.push(id);
      else failed.push({ id, reason: startedResult.reason });
    }

    this.externalAppsCache = null;
    const reason =
      `已停止 ${stoppedPids.length} 个外部进程，接管 ${started.length} 个应用` +
      (failed.length > 0 ? `，${failed.length} 个失败` : '') +
      (skipped.length > 0 ? `，${skipped.length} 个跳过` : '') +
      '。';
    return {
      takenOver: started.length,
      stoppedPids,
      started,
      failed,
      skipped,
      reason,
    };
  }

  /**
   * 接管单个应用。
   * @param {string} id
   * @returns {Promise<any>}
   */
  async takeoverApp(id) {
    return this.takeoverApps([id]);
  }

  /**
   * 接管一个项目下所有"外部启动"的应用；已经由 dockyard 运行的不会重复启动。
   * @param {string} projectId
   * @returns {Promise<any>}
   */
  async takeoverProject(projectId) {
    const external = await this.listExternalApps({ fresh: true });
    const ids = external.apps.filter((app) => app.projectId === projectId).map((app) => app.id);
    if (ids.length === 0) {
      return {
        takenOver: 0,
        stoppedPids: [],
        started: [],
        failed: [],
        skipped: [],
        reason: '该项目下没有发现外部启动的应用。',
      };
    }
    return this.takeoverApps(ids);
  }

  /**
   * 接管所有已托管项目下"外部启动"的应用。
   * @returns {Promise<any>}
   */
  async takeoverAll() {
    const external = await this.listExternalApps({ fresh: true });
    const ids = external.apps.map((app) => app.id);
    if (ids.length === 0) {
      return {
        takenOver: 0,
        stoppedPids: [],
        started: [],
        failed: [],
        skipped: [],
        reason: '没有发现外部启动的应用。',
      };
    }
    return this.takeoverApps(ids);
  }

  /**
   * 兼容旧入口：项目级接管不再重新扫描项目，也不启动项目下全部应用。
   * @param {string} projectId
   * @returns {Promise<any>}
   */
  async takeoverProjectFromScan(projectId) {
    return this.takeoverProject(projectId);
  }

  /** 当前保活/退避策略。 */
  get guardPolicy() {
    return this.store.state.guardPolicy ?? defaultGuardPolicy();
  }

  /**
   * 更新保活策略。只影响后续的手动启动/接管与重试，不会启动或停止任何应用。
   * @param {Partial<import('./store.js').GuardPolicy>} patch
   * @returns {Promise<import('./store.js').GuardPolicy>}
   */
  async setGuardPolicy(patch) {
    const current = this.guardPolicy;
    /** @type {any} */
    const next = { ...current, ...(patch ?? {}) };
    if (typeof next.enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值。');
    const integer = (
      /** @type {string} */ key,
      /** @type {number} */ min,
      /** @type {number} */ max,
    ) => {
      const value = next[key];
      if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
        throw new TypeError(`${key} 必须是 ${min}..${max} 之间的整数。`);
      }
      next[key] = Number(value);
    };
    integer('maxRetries', 0, 20);
    integer('backoffBaseMs', 500, 600000);
    integer('backoffMaxMs', 500, 3600000);
    integer('resetAfterMs', 1000, 86400000);
    if (next.backoffMaxMs < next.backoffBaseMs) {
      throw new TypeError('backoffMaxMs 不能小于 backoffBaseMs。');
    }

    this.store.state.guardPolicy = next;
    if (!next.enabled) {
      for (const record of this.store.list()) {
        if (record.guard?.active) {
          this.#deactivateGuard(record, '保活策略已关闭，守护停止。', false);
        }
      }
    }
    await this.store.save();
    return next;
  }

  /** @param {string} id */
  #clearGuardTimer(id) {
    const timer = this.guardTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.guardTimers.delete(id);
    }
  }

  /**
   * @param {any} record
   * @param {string} reason
   * @param {boolean} [exhausted]
   */
  #deactivateGuard(record, reason, exhausted = false) {
    this.#clearGuardTimer(record.id);
    if (!record.guard) return;
    record.guard = {
      ...record.guard,
      active: false,
      nextAttemptAt: undefined,
      exhausted,
      reason,
    };
  }

  /**
   * 手动启动/接管时开启守护。关闭保活策略时只记录"未开启"，不安排重试。
   * @param {any} record
   */
  #armGuard(record) {
    const policy = this.guardPolicy;
    this.#clearGuardTimer(record.id);
    record.guard = {
      active: policy.enabled,
      attempts: 0,
      lastStartAt: Date.now(),
      exhausted: false,
      reason: policy.enabled
        ? '手动启动，守护已开启。'
        : '手动启动；保活策略已关闭，不会自动重试。',
    };
  }

  /**
   * 异常退出后安排下一次重试。只有手动启动/接管过的应用才有 active 守护。
   * @param {string} id
   */
  #scheduleGuardRetry(id) {
    const record = this.store.get(id);
    if (!record || record.guard?.active !== true) return;
    const policy = this.guardPolicy;
    if (!policy.enabled) {
      this.#deactivateGuard(record, '保活策略已关闭，守护停止。', false);
      void this.store.save();
      return;
    }
    const now = Date.now();
    // 稳定运行超过 resetAfterMs 后，下一次异常重新从第 1 次开始计数。
    if (
      record.guard.lastStartAt !== undefined &&
      now - record.guard.lastStartAt >= policy.resetAfterMs
    ) {
      record.guard.attempts = 0;
    }
    const attempts = record.guard.attempts ?? 0;
    if (attempts >= policy.maxRetries) {
      this.#deactivateGuard(record, `连续自动重试 ${attempts} 次仍失败，守护已停止。`, true);
      void this.store.save();
      return;
    }
    const delay = Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** attempts);
    record.guard.lastFailureAt = now;
    record.guard.nextAttemptAt = now + delay;
    record.guard.reason = `进程异常退出；${Math.max(
      1,
      Math.round(delay / 1000),
    )} 秒后重试（${attempts + 1}/${policy.maxRetries}）。`;
    void this.store.save();
    this.#clearGuardTimer(id);
    const timer = setTimeout(() => {
      this.guardTimers.delete(id);
      void this.#retryGuard(id);
    }, delay);
    timer.unref?.();
    this.guardTimers.set(id, timer);
  }

  /**
   * 定时器到点后执行一次自动重试。
   * @param {string} id
   */
  async #retryGuard(id) {
    const record = this.store.get(id);
    if (!record || record.guard?.active !== true) return;
    const policy = this.guardPolicy;
    if (!policy.enabled) {
      this.#deactivateGuard(record, '保活策略已关闭，守护停止。', false);
      await this.store.save();
      return;
    }
    const attempts = record.guard.attempts ?? 0;
    if (attempts >= policy.maxRetries) {
      this.#deactivateGuard(record, `连续自动重试 ${attempts} 次仍失败，守护已停止。`, true);
      await this.store.save();
      return;
    }
    record.guard.attempts = attempts + 1;
    record.guard.nextAttemptAt = undefined;
    record.guard.reason = `第 ${attempts + 1} 次自动重试。`;
    await this.store.save();
    await this.#startApp(id);
  }

  /**
   * 启动一个应用（手动入口）。手动启动会重新开启守护并清零重试计数。
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

    this.#armGuard(record);
    return this.#startApp(id);
  }

  /**
   * 实际拉起进程。手动启动和自动重试共用，避免两条路径行为分叉。
   * @param {string} id
   * @returns {Promise<{ started: boolean, reason: string, pid?: number }>}
   */
  async #startApp(id) {
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

    await this.#appendSystemLog(record.logFile, '正在启动。');
    try {
      const handle = await startSupervisedProcess({
        id,
        // 不直接把应用挂到 DSH 下：由独立启动器拉起，日志、信号与生命周期都归启动器。
        command: process.execPath,
        args: [APP_LAUNCHER],
        cwd: record.dir,
        quiet: true,
        env: {
          DOCKYARD_LAUNCH_LOG: record.logFile ?? '',
          DOCKYARD_LAUNCH_CWD: record.dir,
          DOCKYARD_LAUNCH_COMMAND: record.command,
          DOCKYARD_LAUNCH_ARGS: JSON.stringify(record.args ?? []),
          DOCKYARD_LAUNCH_MAX_BYTES: String(8 * 1024 * 1024),
        },
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
          void this.#appendSystemLog(
            current.logFile,
            status === 'stopped'
              ? '进程已停止。'
              : `进程异常退出（code=${detail.code} signal=${detail.signal}）。`,
          );
          void this.store.save();
          void this.#removeRuntimeRecord(id);
          if (status !== 'stopped') this.#scheduleGuardRetry(id);
        },
      });

      this.processes.set(id, handle);
      record.status = 'running';
      record.statusReason = '进程已启动。';
      record.pid = handle.pid;
      record.startedAt = Date.now();
      record.stoppedAt = undefined;
      record.exitCode = undefined;
      await this.#writeRuntimeRecord(record, handle.pid);
      if (record.guard?.active) {
        record.guard.lastStartAt = Date.now();
        record.guard.nextAttemptAt = undefined;
        record.guard.reason = `守护中；已自动重试 ${record.guard.attempts ?? 0} 次。`;
      }
      await this.store.save();
      await this.#appendSystemLog(record.logFile, `已启动（pid ${handle.pid}）。`);
      return { started: true, reason: `已启动（pid ${handle.pid}）。`, pid: handle.pid };
    } catch (error) {
      record.status = 'crashed';
      record.statusReason = `启动失败：${error instanceof Error ? error.message : String(error)}`;
      record.pid = undefined;
      await this.store.save();
      await this.#appendSystemLog(record.logFile, record.statusReason);
      if (record.guard?.active) this.#scheduleGuardRetry(id);
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

    // 手动停止（包括非托管应用的停止）必须关掉守护，避免停止后又被自动拉起。
    if (record.guard?.active) {
      this.#deactivateGuard(record, '用户手动停止，守护已关闭。');
    } else {
      this.#clearGuardTimer(id);
    }

    const handle = this.processes.get(id);
    if (!handle) {
      // 没有 dockyard 句柄时，先看是不是外部启动的应用。非托管应用也允许停止：
      // 停止的只是匹配到的外部进程，不会把它转成托管运行。
      const external = await this.listExternalApps({ fresh: true });
      const target = external.apps.find((app) => app.id === id);
      if (target) {
        const failed = [];
        let stoppedCount = 0;
        for (const process of target.stopProcesses ?? []) {
          const result = await this.terminateImpl(process, this.stopOptions ?? {});
          if (result.stopped) stoppedCount += 1;
          else failed.push(`pid ${process.pid}`);
        }
        if (failed.length > 0) {
          record.status = 'crashed';
          record.statusReason = `外部进程未能停止：${failed.join('、')}。`;
          await this.store.save();
          return { stopped: false, reason: record.statusReason };
        }
        record.status = 'stopped';
        record.statusReason = `已停止 ${stoppedCount} 个外部进程。`;
        record.stoppedAt = Date.now();
        record.pid = undefined;
        await this.#removeRuntimeRecord(id);
        await this.store.save();
        this.externalAppsCache = null;
        return { stopped: true, reason: record.statusReason };
      }

      // 宿主重启后遗留的 unknown，或本来就没启动。
      if (record.status === 'unknown') {
        record.status = 'stopped';
        record.statusReason = '用户确认标记为已停止（本插件无法回收非本进程启动的进程）。';
        await this.#removeRuntimeRecord(id);
        await this.store.save();
        return { stopped: true, reason: record.statusReason };
      }
      record.status = 'stopped';
      record.statusReason = '应用未在运行。';
      await this.#removeRuntimeRecord(id);
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
      await this.#removeRuntimeRecord(id);
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
    // 子进程输出直接写文件，没有内存缓冲需要落盘；保留方法兼容调用方。
  }

  /**
   * 插件卸载时的收尾。
   *
   * 默认**不**杀死被托管的进程：dockyard 的价值之一就是进程不随客户端消失。
   * 记录保留 running + 启动器 pid，下次 init() 通过 pid 重新认领。
   *
   * @param {{ killProcesses?: boolean }} [options]
   * @returns {Promise<{ killed: number, leftRunning: number }>}
   */
  async shutdown(options = {}) {
    this.#stopMetrics();
    this.#stopSync();
    for (const record of this.store.list()) {
      // 没有对应进程的守护没有继续意义；仍在运行的守护保留，下次启动时接回来。
      if (record.guard?.active && !this.processes.has(record.id)) {
        this.#deactivateGuard(record, '宿主关闭时应用未运行，守护已暂停。');
      } else {
        this.#clearGuardTimer(record.id);
      }
    }

    if (options.killProcesses) {
      let killed = 0;
      for (const [id, handle] of [...this.processes.entries()]) {
        const result = await stopSupervisedProcess(handle, this.stopOptions ?? {});
        if (result.stopped) killed += 1;
        const record = this.store.get(id);
        if (record) {
          this.#deactivateGuard(record, '插件卸载时按要求停止了进程，守护已关闭。');
          record.status = 'stopped';
          record.statusReason = '插件卸载时按要求停止了进程。';
          record.stoppedAt = Date.now();
          record.pid = undefined;
          await this.#removeRuntimeRecord(id);
        }
      }
      this.processes.clear();
      await this.store.save();
      return { killed, leftRunning: 0 };
    }

    const leftRunning = this.processes.size;
    for (const [id, handle] of this.processes) {
      const record = this.store.get(id);
      if (!record) continue;
      // 进程不随插件退出；保留 running + pid，下次 init() 通过 pid 重新认领。
      record.status = 'running';
      record.statusReason = '宿主已关闭，进程仍在运行；下次启动时重新接管。';
      record.pid = handle.pid;
      if (record.guard?.active) {
        record.guard.nextAttemptAt = undefined;
        record.guard.reason = '宿主已关闭，进程继续运行；下次启动时重新接管，守护继续。';
      }
    }
    this.processes.clear();
    await this.store.save();
    return { killed: 0, leftRunning };
  }
}
