/**
 * dockyard 的持久化状态。
 *
 * 存什么、不存什么（这个划分是整个插件可信度的基础）：
 *
 * - **存**元数据：应用清单、启动参数、最近一次状态与原因、日志文件路径。
 *   这些是"发生过什么"的记录，重启宿主后仍应可读。
 * - **不存**进程句柄，也**不假装知道**重启前的进程是否还活着。
 *   宿主进程重启后，之前托管的进程要么已经随之退出，要么成了孤儿；
 *   两者都无法可靠判断。所以加载时一律把状态标为 `unknown`，
 *   由用户显式确认或重新启动，而不是谎报"正在运行"。
 *
 * 用一个 JSON 文件而不是数据库：这里的写入量很小（每次状态变化一次），
 * 原子替换即可保证一致性，引入 SQLite 只会多一份需要维护的依赖。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 应用的状态取值。`unknown` 专指"宿主重启后无法确认"，与"已停止"不同。 */
export const APP_STATUS = /** @type {const} */ ([
  'unknown',
  'stopped',
  'starting',
  'running',
  'stopping',
  'crashed',
]);

/** 已知的运行器类型。未知值在解析时退回 shell，避免旧/坏记录让整行消失。 */
export const APP_RUNNERS = /** @type {const} */ ([
  'node',
  'python',
  'shell',
  'maven',
  'gradle',
  'php',
  'flutter',
  'dart',
  'go',
  'rust',
  'dotnet',
  'ruby',
]);

/**
 * @typedef {object} ApplicationRecord
 * @property {string} id 稳定标识
 * @property {string} name 展示名
 * @property {string} dir 工作目录
 * @property {(typeof APP_RUNNERS)[number]} runner 运行器类型
 * @property {string} command 启动命令
 * @property {string[]} args 启动参数
 * @property {string} reason 首次被识别出来的理由（保留原始判定依据）
 * @property {string} [projectId] 所属项目 id
 * @property {string} [projectName] 所属项目展示名
 * @property {string} [projectRoot] 项目根目录
 * @property {string} [ecosystemId] 生态分组 id
 * @property {string} [ecosystemName] 生态分组展示名
 * @property {string} [language] 语言
 * @property {string} [manager] 包管理器
 * @property {boolean} [missing] 周期同步时发现磁盘上已不存在
 * @property {number} [missingAt] 失联时间
 * @property {number} [lastSeenAt] 最近一次在扫描结果中出现的时间
 * @property {boolean} [restartRequired] 源码结构/启动命令变化，运行中的应用需要重启
 * @property {{ at: number, command: string, args: string[], reason: string }[]} [commandHistory] 旧启动参数历史
 * @property {(typeof APP_STATUS)[number]} status 最近一次已知状态
 * @property {string} [statusReason] 状态变化的原因，面向用户解释
 * @property {number} [pid] 最近一次的进程号
 * @property {number} [startedAt] 最近一次启动时间（毫秒）
 * @property {number} [stoppedAt] 最近一次停止时间（毫秒）
 * @property {number} [exitCode] 最近一次的退出码
 * @property {string} logFile 日志文件路径
 * @property {number} addedAt 加入时间（毫秒）
 */

/**
 * @typedef {object} DockyardState
 * @property {number} version 状态文件的结构版本，字段语义变化时递增
 * @property {string[]} scanRoots 用户配置的扫描根目录
 * @property {Record<string, ApplicationRecord>} applications 以 id 为键的应用表
 * @property {number} updatedAt 最近一次写入时间
 */

/** 当前状态文件结构版本。加载到更低版本时按"未知字段忽略、缺失字段补默认"处理。 */
export const STATE_VERSION = 3;

/**
 * 建一个空状态。
 * @returns {DockyardState}
 */
export function emptyState() {
  return { version: STATE_VERSION, scanRoots: [], applications: {}, updatedAt: Date.now() };
}

/**
 * 把外部读入的内容解析成可信状态。
 *
 * 这是"边界处解析"的落点：状态文件可能被手工编辑过、可能来自旧版本、
 * 也可能被写坏。任何不合形状的字段都被替换成安全默认值，并记入 problems，
 * 而不是让它带着脏数据往下流。
 *
 * @param {unknown} raw
 * @returns {{ state: DockyardState, problems: string[] }}
 */
export function parseState(raw) {
  /** @type {string[]} */
  const problems = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: emptyState(), problems: ['状态文件顶层不是对象，已重置为空状态。'] };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);

  const version = Number.isInteger(source.version) ? Number(source.version) : 0;
  if (version > STATE_VERSION) {
    problems.push(`状态文件版本 ${version} 高于本插件支持的 ${STATE_VERSION}，未知字段已忽略。`);
  }

  const scanRoots = Array.isArray(source.scanRoots)
    ? source.scanRoots.filter((item) => typeof item === 'string' && item.trim() !== '')
    : [];
  if (source.scanRoots !== undefined && !Array.isArray(source.scanRoots)) {
    problems.push('scanRoots 不是数组，已忽略。');
  }

  /** @type {Record<string, ApplicationRecord>} */
  const applications = {};
  const rawApps = source.applications;
  if (
    rawApps !== undefined &&
    (rawApps === null || typeof rawApps !== 'object' || Array.isArray(rawApps))
  ) {
    problems.push('applications 不是对象，已忽略。');
  } else if (rawApps && typeof rawApps === 'object') {
    for (const [id, value] of Object.entries(rawApps)) {
      const record = parseApplication(id, value, problems);
      if (record) applications[id] = record;
    }
  }

  return {
    state: {
      version: STATE_VERSION,
      scanRoots,
      applications,
      updatedAt: Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : Date.now(),
    },
    problems,
  };
}

/**
 * 解析单条应用记录。缺少必需字段时返回 null（宁可不显示，也不要显示一个点不动就报错的行）。
 *
 * @param {string} id
 * @param {unknown} value
 * @param {string[]} problems
 * @returns {ApplicationRecord | null}
 */
function parseApplication(id, value, problems) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`应用 ${id} 的记录不是对象，已跳过。`);
    return null;
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof raw.dir !== 'string' ||
    raw.dir === '' ||
    typeof raw.command !== 'string' ||
    raw.command === ''
  ) {
    problems.push(`应用 ${id} 缺少 dir 或 command，已跳过。`);
    return null;
  }

  const runner = APP_RUNNERS.includes(/** @type {any} */ (raw.runner))
    ? /** @type {any} */ (raw.runner)
    : 'shell';
  const status = APP_STATUS.includes(/** @type {any} */ (raw.status))
    ? /** @type {any} */ (raw.status)
    : 'unknown';

  return {
    id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
    dir: raw.dir,
    runner,
    command: raw.command,
    args: Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [],
    reason: typeof raw.reason === 'string' ? raw.reason : '（无记录）',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : undefined,
    projectName: typeof raw.projectName === 'string' ? raw.projectName : undefined,
    projectRoot: typeof raw.projectRoot === 'string' ? raw.projectRoot : undefined,
    ecosystemId: typeof raw.ecosystemId === 'string' ? raw.ecosystemId : undefined,
    ecosystemName: typeof raw.ecosystemName === 'string' ? raw.ecosystemName : undefined,
    language: typeof raw.language === 'string' ? raw.language : undefined,
    manager: typeof raw.manager === 'string' ? raw.manager : undefined,
    missing: raw.missing === true,
    missingAt: Number.isFinite(raw.missingAt) ? Number(raw.missingAt) : undefined,
    lastSeenAt: Number.isFinite(raw.lastSeenAt) ? Number(raw.lastSeenAt) : undefined,
    restartRequired: raw.restartRequired === true,
    commandHistory: Array.isArray(raw.commandHistory)
      ? raw.commandHistory
          .filter(
            (entry) =>
              entry &&
              typeof entry === 'object' &&
              typeof entry.command === 'string' &&
              Array.isArray(entry.args),
          )
          .slice(-10)
          .map((entry) => ({
            at: Number.isFinite(entry.at) ? Number(entry.at) : Date.now(),
            command: String(entry.command),
            args: entry.args.filter((/** @type {unknown} */ arg) => typeof arg === 'string'),
            reason: typeof entry.reason === 'string' ? entry.reason : '',
          }))
      : undefined,
    status,
    statusReason: typeof raw.statusReason === 'string' ? raw.statusReason : undefined,
    pid: Number.isInteger(raw.pid) ? Number(raw.pid) : undefined,
    startedAt: Number.isFinite(raw.startedAt) ? Number(raw.startedAt) : undefined,
    stoppedAt: Number.isFinite(raw.stoppedAt) ? Number(raw.stoppedAt) : undefined,
    exitCode: Number.isFinite(raw.exitCode) ? Number(raw.exitCode) : undefined,
    logFile: typeof raw.logFile === 'string' ? raw.logFile : '',
    addedAt: Number.isFinite(raw.addedAt) ? Number(raw.addedAt) : Date.now(),
  };
}

/**
 * 状态文件的读写。
 *
 * 写入用"临时文件 + rename"：rename 在同一文件系统内是原子的，
 * 因此不会出现"读到一个写了一半的 JSON"这种情况。
 */
export class StateStore {
  /**
   * @param {string} file 状态文件的绝对路径
   */
  constructor(file) {
    this.file = file;
    /** @type {DockyardState} */
    this.state = emptyState();
    /** @type {string[]} */
    this.problems = [];
    /** @type {Promise<void>} 串行化写入 */
    this.writeChain = Promise.resolve();
  }

  /**
   * 从磁盘加载。文件不存在时视为首次运行，不算错误。
   * @returns {Promise<{ loaded: boolean, problems: string[] }>}
   */
  async load() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      this.state = emptyState();
      return { loaded: false, problems: [] };
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      const message = `状态文件不是合法 JSON（${error instanceof Error ? error.message : String(error)}），已重置为空状态。`;
      this.state = emptyState();
      this.problems = [message];
      return { loaded: false, problems: [message] };
    }

    const { state, problems } = parseState(raw);
    // 宿主重启后无法确认任何进程的死活：一律降级为 unknown，绝不谎报 running。
    for (const record of Object.values(state.applications)) {
      if (
        record.status === 'running' ||
        record.status === 'starting' ||
        record.status === 'stopping'
      ) {
        record.status = 'unknown';
        record.statusReason =
          '宿主进程已重启，无法确认该进程是否仍在运行，请重新启动或标记为已停止。';
        record.pid = undefined;
      }
    }
    this.state = state;
    this.problems = problems;
    return { loaded: true, problems };
  }

  /**
   * 写入磁盘。多次调用会被串行化。
   * @returns {Promise<void>}
   */
  async save() {
    this.state.updatedAt = Date.now();
    const payload = JSON.stringify(this.state, null, 2);
    const file = this.file;
    const temp = `${file}.tmp`;
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temp, payload, 'utf8');
        await rename(temp, file);
      })
      .catch(() => {
        // 落盘失败不应让插件崩掉；内存状态仍然可用，下次变化会再试。
      });
    return this.writeChain;
  }

  /**
   * 列出全部应用，按名称排序，保证面板顺序稳定。
   * @returns {ApplicationRecord[]}
   */
  list() {
    return Object.values(this.state.applications).sort((a, b) =>
      a.name.localeCompare(b.name, 'zh'),
    );
  }

  /**
   * 读取一条应用记录。
   * @param {string} id
   * @returns {ApplicationRecord | undefined}
   */
  get(id) {
    return this.state.applications[id];
  }

  /**
   * 新增或更新一条应用记录。
   * @param {ApplicationRecord} record
   */
  put(record) {
    this.state.applications[record.id] = record;
  }

  /**
   * 删除一条应用记录。
   * @param {string} id
   * @returns {boolean} 是否真的删掉了
   */
  remove(id) {
    if (!(id in this.state.applications)) return false;
    delete this.state.applications[id];
    return true;
  }
}
