/**
 * dockyard 的 Client（浏览器）半侧。
 *
 * 硬约束（违反不会在构建期报错，只会在用户侧炸掉）：
 * - 只允许 require('react')。React 由浏览器模块表提供，不自行安装、不引 CDN。
 * - 禁止 require 任何 @deepseek-ai/dsh-client-* 包。DSH 官方明确禁止，且会随版本变化。
 * - 样式只用 --dsw-alias-* 主题 token；字面色只出现在状态语义色的兜底值上
 *   （圆点与统计数字），不属于配色。
 * - 不在组件外操作 DOM，不往 document.body 追加内容。
 * - 工厂必须无副作用：定义与返回，注册都放在 apply 里。
 *
 * 界面由两处组成：
 * 1. 左侧栏入口 `sidebar.panellist` + 全局页 `main`（key 与入口 id 相同）；
 * 2. 输入框上方的状态停靠条 `conversation.input.dock`，可跳转到整页。
 *
 * 数据来源：Host 半侧的三个同源、仅回环路由——/status（读）、/logs（读）、/action（写）。
 * 写路由要求自定义头，跨站页面无法伪造；详见 src/http.js 的安全边界说明。
 */

window.__ModuleLoader__.load({
  id: '@dsh-plugins/dockyard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATUS_ROUTE = '/plugin/dockyard/status';
    const LOGS_ROUTE = '/plugin/dockyard/logs';
    const ACTION_ROUTE = '/plugin/dockyard/action';
    /** 入口 id 与 main 面板的 key 必须一致，否则点击入口会找不到页面。 */
    const PANEL_ID = 'dockyard';
    /** Client locale 命名空间。 */
    const NS = 'dockyard';
    /**
     * preload 注入的目录选择接口全局名。
     * 拆开拼接而不是写字面量：仓库健康检查把连续的 __XXX__ 当成未替换的模板占位符。
     */
    const DIRECTORY_PICKER_BRIDGE = ['__DSH', 'DIRECTORY', 'PICKER__'].join('_');
    const POLL_INTERVAL_MS = 5000;
    const LOG_POLL_INTERVAL_MS = 3000;
    /**
     * 面板里切换状态条后广播的事件。dock 与页面是两个独立 slot 组件，
     * 靠这个事件立即同步，而不是等下一次 5 秒轮询。
     */
    const DOCK_REFRESH_EVENT = 'dockyard:refresh';
    /**
     * 状态条开关的本地缓存。Host 的状态才是事实源，这份缓存只用来避免
     * 每次打开页面都先画出一条 bar、等第一次轮询回来再把它去掉。
     */
    const STATUS_BAR_CACHE_KEY = 'dockyard:status-bar-visible';

    /** 状态到文案 key 的映射。未知状态刻意显示"未知"，而不是猜一个。 */
    const STATUS_KEY = {
      running: 'statusRunning',
      starting: 'statusStarting',
      stopping: 'statusStopping',
      stopped: 'statusStopped',
      crashed: 'statusCrashed',
      unknown: 'statusUnknown',
    };

    const DICTIONARIES = {
      zh: {
        panel: '服务坞',
        pageTitle: '服务坞',
        pageSubtitle: '本机开发服务的可观测托管台',
        tabOverview: '概览',
        tabServices: '服务',
        tabDiscover: '发现',
        tabLogs: '日志',
        refresh: '刷新',
        loading: '加载中…',
        unavailable: '状态不可用',
        unavailableHint: '宿主可能未启用 HTTP 服务',
        statRunning: '运行中',
        statCrashed: '异常退出',
        statStopped: '已停止',
        statTotal: '总计',
        statProjects: '项目',
        statCpu: '总 CPU',
        statMemory: '总内存',
        systemTitle: '宿主系统',
        systemMemory: '内存占用（含缓存）',
        systemLoad: '负载',
        systemCores: '核心',
        systemUptime: '运行时长',
        projectsTitle: '项目负载',
        topCpuTitle: 'CPU 排行',
        topMemoryTitle: '内存排行',
        noMetrics: '暂无采样',
        appsRunning: '{running}/{total} 应用',
        colCpu: 'CPU',
        colMemory: '内存',
        attentionTitle: '需要关注',
        attentionEmpty: '没有需要关注的服务。',
        runningTitle: '正在运行',
        runningEmpty: '当前没有运行中的服务。',
        warningsTitle: '诊断',
        emptyTitle: '还没有托管任何服务',
        emptyHint: '扫描一个项目根目录，找到可运行的服务后加入托管。',
        emptyAction: '扫描项目',
        servicesEmpty: '还没有托管任何服务。',
        actionStart: '启动',
        actionStop: '停止',
        actionRestart: '重启',
        actionRemove: '移除',
        actionLogs: '日志',
        actionStartAll: '全部启动',
        actionStopAll: '全部停止',
        actionRestartAll: '全部重启',
        tagLanguage: '语言',
        tagManager: '包管理器',
        languageUnknown: '未知语言',
        projectRunningOfTotal: '{running}/{total} 运行中',
        batchDone: '已处理 {done} 个应用。',
        batchFailed: '{failed} 个应用处理失败：{detail}',
        filterSearch: '搜索项目、应用、路径或命令',
        filterStatusLabel: '状态',
        filterLanguageLabel: '语言',
        filterAll: '全部',
        filterClear: '清除筛选',
        filterSummary: '{shown}/{total} 个项目',
        filterEmpty: '没有符合条件的项目。',
        filterCrashedShort: '异常',
        logModalLabel: '{name} 的日志',
        logModalClose: '关闭日志',
        busy: '处理中…',
        removeConfirm: '确认移除？',
        removeCancel: '取消',
        never: '—',
        discoverTitle: '扫描项目',
        discoverHint:
          '点击「扫描」选择项目所在的目录，选完会自动开始扫描；结果按 项目 → 语言生态 → 应用 归一化。',
        discoverPlaceholder: '/Users/you/projects',
        discoverScan: '扫描',
        discoverScanning: '扫描中…',
        discoverManual: '手动输入路径（没有系统选择器时）',
        discoverPickUnsupported: '当前环境没有可用的系统文件夹选择器，请展开手动输入路径。',
        discoverPickFailed: '打开文件夹选择器失败',
        discoverSummary: '扫描了 {dirs} 个目录，识别出 {projects} 个项目、{apps} 个应用。',
        discoverDiagnostics: '扫描诊断',
        discoverAdd: '加入托管',
        discoverAdding: '加入中…',
        discoverAdded: '已托管',
        discoverNoProjects: '没有识别到项目。',
        discoverNoApps: '未发现可运行应用。',
        discoverNoAppProjects: '未发现可运行应用的项目',
        discoverRootsRequired: '至少输入一个绝对路径。',
        hostProject: '托管项目',
        hostProjectPartial: '补齐托管',
        hostedAll: '已托管',
        hostedCount: '已托管 {added}/{count}',
        selectAll: '全选',
        selectedCount: '已选 {count} 个项目',
        hostSelected: '托管选中项目',
        hostAll: '全部托管',
        hostAllConfirm: '将托管 {projects} 个项目、{apps} 个应用，确认？',
        hostConfirm: '确认托管',
        cancel: '取消',
        removeProject: '移除项目',
        removeProjectConfirm: '移除整个项目？',
        removeProjectHint: '项目下全部应用会被移出托管（日志文件保留）。',
        externalCount: '{count} 个外部进程',
        externalHint:
          '检测到不是 dockyard 启动的进程。接管会先停止它们，再由 dockyard 启动项目应用。',
        takeoverProject: '接管项目',
        takingOver: '接管中…',
        projectGit: 'git',
        projectNoGit: '无 git',
        projectApps: '{count} 个应用',
        containerProjects: '{count} 个项目',
        unclassified: '未归类',
        syncNow: '同步',
        syncing: '同步中…',
        syncNever: '尚未同步',
        syncSummary: '上次同步：新增 {added}，变化 {changed}，失联 {missing}',
        missingBadge: '失联',
        restartRequiredBadge: '需重启',
        autoTakeoverOn: '自动接管：开',
        autoTakeoverOff: '自动接管：关',
        autoTakenOver: '上次自动接管：{name}',
        logsApp: '服务',
        logsLines: '行数',
        logsSource: '来源',
        logsEmpty: '该服务还没有产生日志。',
        logsRefresh: '刷新日志',
        sourceBuffer: '内存缓冲',
        sourceFile: '日志文件尾部',
        sourceNone: '无',
        statusRunning: '运行中',
        statusStarting: '启动中',
        statusStopping: '停止中',
        statusStopped: '已停止',
        statusCrashed: '异常退出',
        statusUnknown: '未知',
        dockLoading: '加载中',
        dockRunningSuffix: '运行中',
        dockCrashedSuffix: '异常',
        dockToggle: '展开或收起本机服务列表',
        dockUnavailable: '状态不可用',
        dockUnavailableHint: '宿主可能未启用 HTTP 服务',
        dockEmpty: '还没有托管任何应用。',
        dockOpen: '打开服务坞',
        dockAria: '服务坞状态',
        dockCrashed: '异常',
        dockMissing: '失联',
        dockRestartRequired: '需重启',
        dockProjects: '项目',
        dockCpu: 'CPU',
        dockMemory: '内存',
        dockEcosystems: '生态',
        dockDetails: '展开或收起服务明细',
        dockAttention: '需要关注',
        dockRunningSection: '正在运行',
        dockAttentionEmpty: '没有需要关注的服务。',
        dockAllApps: '在服务坞查看全部 {count} 个应用',
        dockRetry: '重试',
        dockStatusBar: '输入框状态条',
        dockStatusBarHint: '在输入框上方显示服务坞状态条',
        dockStatusBarOn: '已显示输入框状态条。',
        dockStatusBarOff: '已隐藏输入框状态条，可在服务坞页头重新开启。',
        dockCpuTitle: '运行中应用的 CPU 合计',
        dockMemoryTitle: '运行中应用的 RSS 合计（共享页会重复计算）',
        dockEcoTitle: '语言 / 包管理器分布：{detail}',
        dockHostMemory: '宿主内存 {used} / {total}',
        dismiss: '关闭',
        unknownError: '未知错误',
      },
      en: {
        panel: 'Dockyard',
        pageTitle: 'Dockyard',
        pageSubtitle: 'Observe and supervise local development services',
        tabOverview: 'Overview',
        tabServices: 'Services',
        tabDiscover: 'Discover',
        tabLogs: 'Logs',
        refresh: 'Refresh',
        loading: 'Loading…',
        unavailable: 'Status unavailable',
        unavailableHint: 'the host may not have the HTTP server enabled',
        statRunning: 'Running',
        statCrashed: 'Crashed',
        statStopped: 'Stopped',
        statTotal: 'Total',
        statProjects: 'Projects',
        statCpu: 'Total CPU',
        statMemory: 'Total memory',
        systemTitle: 'Host system',
        systemMemory: 'Memory (incl. cache)',
        systemLoad: 'Load',
        systemCores: 'Cores',
        systemUptime: 'Uptime',
        projectsTitle: 'Project load',
        topCpuTitle: 'CPU ranking',
        topMemoryTitle: 'Memory ranking',
        noMetrics: 'No samples yet',
        appsRunning: '{running}/{total} apps',
        colCpu: 'CPU',
        colMemory: 'Memory',
        attentionTitle: 'Needs attention',
        attentionEmpty: 'Nothing needs attention.',
        runningTitle: 'Running now',
        runningEmpty: 'No services are running.',
        warningsTitle: 'Diagnostics',
        emptyTitle: 'No services hosted yet',
        emptyHint: 'Scan a project root to find runnable services, then add them here.',
        emptyAction: 'Scan projects',
        servicesEmpty: 'No services hosted yet.',
        actionStart: 'Start',
        actionStop: 'Stop',
        actionRestart: 'Restart',
        actionRemove: 'Remove',
        actionLogs: 'Logs',
        actionStartAll: 'Start all',
        actionStopAll: 'Stop all',
        actionRestartAll: 'Restart all',
        tagLanguage: 'Language',
        tagManager: 'Package manager',
        languageUnknown: 'Unknown language',
        projectRunningOfTotal: '{running}/{total} running',
        batchDone: 'Handled {done} app(s).',
        batchFailed: '{failed} app(s) failed: {detail}',
        filterSearch: 'Search projects, apps, paths or commands',
        filterStatusLabel: 'Status',
        filterLanguageLabel: 'Language',
        filterAll: 'All',
        filterClear: 'Clear filters',
        filterSummary: '{shown}/{total} projects',
        filterEmpty: 'No projects match these filters.',
        filterCrashedShort: 'Failing',
        logModalLabel: 'Logs for {name}',
        logModalClose: 'Close logs',
        busy: 'Working…',
        removeConfirm: 'Remove?',
        removeCancel: 'Cancel',
        never: '—',
        discoverTitle: 'Scan a project folder',
        discoverHint:
          'Click Scan, pick the folder that contains your projects, and scanning starts automatically. Results are normalized as project → ecosystem → app.',
        discoverPlaceholder: '/Users/you/projects',
        discoverScan: 'Scan',
        discoverScanning: 'Scanning…',
        discoverManual: 'Type a path manually (no system picker available)',
        discoverPickUnsupported:
          'This environment has no system folder picker; expand manual input instead.',
        discoverPickFailed: 'Could not open the folder picker',
        discoverSummary: 'Scanned {dirs} directories: {projects} projects, {apps} apps.',
        discoverDiagnostics: 'Scan diagnostics',
        discoverAdd: 'Add',
        discoverAdding: 'Adding…',
        discoverAdded: 'Hosted',
        discoverNoProjects: 'No projects recognized.',
        discoverNoApps: 'No runnable applications found.',
        discoverNoAppProjects: 'Projects without runnable apps',
        discoverRootsRequired: 'Enter at least one absolute path.',
        hostProject: 'Host project',
        hostProjectPartial: 'Host remaining',
        hostedAll: 'Hosted',
        hostedCount: 'Hosted {added}/{count}',
        selectAll: 'Select all',
        selectedCount: '{count} projects selected',
        hostSelected: 'Host selected',
        hostAll: 'Host all',
        hostAllConfirm: 'Host {projects} projects and {apps} apps?',
        hostConfirm: 'Host',
        cancel: 'Cancel',
        removeProject: 'Remove project',
        removeProjectConfirm: 'Remove the whole project?',
        removeProjectHint: 'All apps under this project leave hosting; log files are kept.',
        externalCount: '{count} external processes',
        externalHint:
          'Processes not started by dockyard were found. Takeover stops them first, then starts the project apps under dockyard.',
        takeoverProject: 'Take over',
        takingOver: 'Taking over…',
        projectGit: 'git',
        projectNoGit: 'no git',
        projectApps: '{count} apps',
        containerProjects: '{count} projects',
        unclassified: 'Unclassified',
        syncNow: 'Sync',
        syncing: 'Syncing…',
        syncNever: 'Not synced yet',
        syncSummary: 'Last sync: +{added}, changed {changed}, missing {missing}',
        missingBadge: 'Missing',
        restartRequiredBadge: 'Restart required',
        autoTakeoverOn: 'Auto takeover: on',
        autoTakeoverOff: 'Auto takeover: off',
        autoTakenOver: 'Last auto takeover: {name}',
        logsApp: 'Service',
        logsLines: 'Lines',
        logsSource: 'Source',
        logsEmpty: 'This service has no logs yet.',
        logsRefresh: 'Refresh logs',
        sourceBuffer: 'memory buffer',
        sourceFile: 'log file tail',
        sourceNone: 'none',
        statusRunning: 'Running',
        statusStarting: 'Starting',
        statusStopping: 'Stopping',
        statusStopped: 'Stopped',
        statusCrashed: 'Crashed',
        statusUnknown: 'Unknown',
        dockLoading: 'loading',
        dockRunningSuffix: 'running',
        dockCrashedSuffix: 'crashed',
        dockToggle: 'Expand or collapse hosted services',
        dockUnavailable: 'Status unavailable',
        dockUnavailableHint: 'the host may not have the HTTP server enabled',
        dockEmpty: 'No services hosted yet.',
        dockOpen: 'Open Dockyard',
        dockAria: 'Dockyard status',
        dockCrashed: 'crashed',
        dockMissing: 'missing',
        dockRestartRequired: 'restart needed',
        dockProjects: 'projects',
        dockCpu: 'CPU',
        dockMemory: 'memory',
        dockEcosystems: 'stacks',
        dockDetails: 'Expand or collapse service details',
        dockAttention: 'Needs attention',
        dockRunningSection: 'Running',
        dockAttentionEmpty: 'Nothing needs attention.',
        dockAllApps: 'Open Dockyard to see all {count} apps',
        dockRetry: 'Retry',
        dockStatusBar: 'Composer status bar',
        dockStatusBarHint: 'Show the Dockyard status bar above the composer',
        dockStatusBarOn: 'Composer status bar is on.',
        dockStatusBarOff: 'Composer status bar is off. Re-enable it from the Dockyard header.',
        dockCpuTitle: 'Total CPU of running apps',
        dockMemoryTitle: 'Total RSS of running apps (shared pages are double-counted)',
        dockEcoTitle: 'Language / package manager breakdown: {detail}',
        dockHostMemory: 'Host memory {used} / {total}',
        dismiss: 'Dismiss',
        unknownError: 'Unknown error',
      },
    };

    /** 在拿到 slot 注入的 t 之前的兜底：至少返回 key，不崩。 */
    const fallbackT = (key) => key;

    /**
     * 读状态条开关的本地缓存；存储不可用或被禁用时按"展示"处理。
     * @returns {boolean}
     */
    function readStatusBarCache() {
      try {
        const value = globalThis.localStorage?.getItem(STATUS_BAR_CACHE_KEY);
        return value === null || value === undefined ? true : value !== '0';
      } catch {
        return true;
      }
    }

    /**
     * 写状态条开关的本地缓存。写失败不影响功能，Host 侧仍会持久化。
     * @param {boolean} visible
     */
    function writeStatusBarCache(visible) {
      try {
        globalThis.localStorage?.setItem(STATUS_BAR_CACHE_KEY, visible ? '1' : '0');
      } catch {
        // 存储被禁用时忽略：下一次轮询仍会拿到 Host 的真实值。
      }
    }

    /**
     * 把模板里的 {name} 替换成值。
     * @param {string} template
     * @param {Record<string, string | number>} values
     * @returns {string}
     */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
      );
    }

    /**
     * 毫秒转紧凑时长，例如 3m 12s。空值显示破折号。
     * @param {number | undefined} ms
     * @param {{ never: string }} t
     * @returns {string}
     */
    function formatUptime(ms, t) {
      if (!Number.isFinite(ms) || Number(ms) <= 0) return t.never;
      const seconds = Math.floor(Number(ms) / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ${minutes % 60}m`;
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }

    /**
     * 字节数转紧凑单位。
     * @param {number | undefined} bytes
     * @returns {string}
     */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || Number(bytes) <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = Number(bytes);
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
    }

    /**
     * 百分比格式；无值返回破折号。
     * @param {number | undefined} value
     * @param {string} never
     */
    function formatPercent(value, never) {
      return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : never;
    }

    /** @param {unknown} error */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /**
     * 读一次状态快照。
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ applications: any[], projects: any[], system: any, preferences: { statusBar: boolean }, warnings: string[], scanRoots: string[] }>}
     */
    async function fetchStatus(signal) {
      const response = await fetch(STATUS_ROUTE, {
        signal,
        headers: { accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok !== true) {
        throw new Error(
          (body && typeof body.error === 'string' && body.error) ||
            `状态接口返回 ${response.status}`,
        );
      }
      return {
        applications: Array.isArray(body.applications) ? body.applications : [],
        projects: Array.isArray(body.projects) ? body.projects : [],
        system: body.system && typeof body.system === 'object' ? body.system : null,
        // 旧 Host 不返回 preferences 时保持"展示"，避免升级瞬间界面突然少一块。
        preferences: {
          statusBar:
            body.preferences && typeof body.preferences === 'object'
              ? body.preferences.statusBar !== false
              : true,
        },
        sync: body.sync && typeof body.sync === 'object' ? body.sync : null,
        syncIntervalMs: Number(body.syncIntervalMs) || 0,
        autoTakeover: body.autoTakeover === true,
        lastAutoTakeover:
          body.lastAutoTakeover && typeof body.lastAutoTakeover === 'object'
            ? body.lastAutoTakeover
            : null,
        warnings: Array.isArray(body.warnings) ? body.warnings : [],
        scanRoots: Array.isArray(body.scanRoots) ? body.scanRoots : [],
      };
    }

    /**
     * 读一次日志。
     * @param {string} id
     * @param {number} lines
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ lines: string[], source: string }>}
     */
    async function fetchLogs(id, lines, signal) {
      const query = new URLSearchParams({ id, lines: String(lines) });
      const response = await fetch(`${LOGS_ROUTE}?${query}`, {
        signal,
        headers: { accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok !== true) {
        throw new Error(
          (body && typeof body.error === 'string' && body.error) ||
            `日志接口返回 ${response.status}`,
        );
      }
      return {
        lines: Array.isArray(body.lines) ? body.lines : [],
        source: typeof body.source === 'string' ? body.source : 'none',
      };
    }

    /**
     * 发一个写操作。自定义头是 Host 侧鉴权的一部分，不能省略。
     * @param {string} action
     * @param {Record<string, unknown>} payload
     * @returns {Promise<any>}
     */
    async function postAction(action, payload) {
      const response = await fetch(ACTION_ROUTE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dockyard-action': '1',
        },
        body: JSON.stringify({ action, ...payload }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok !== true) {
        throw new Error(
          (body && typeof body.error === 'string' && body.error) ||
            `操作接口返回 ${response.status}`,
        );
      }
      return body.result;
    }

    const CSS = `
.dy-root {
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  padding: calc(var(--dsh-frame-top-clearance, 0px) + 20px) 24px 40px;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  line-height: 1.5;
}
.dy-inner {
  max-width: 1080px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.dy-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.dy-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.dy-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, inherit);
}
.dy-header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
  flex: 0 0 auto;
}
.dy-busy {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, inherit);
}
.dy-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, currentColor);
}
.dy-tab {
  appearance: none;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 8px 12px;
  margin-bottom: -1px;
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  border-radius: 6px 6px 0 0;
}
.dy-tab:hover {
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-interactive-bg-hover, transparent);
}
.dy-tab[aria-selected='true'] {
  color: var(--dsw-alias-label-primary, inherit);
  border-bottom-color: var(--dsw-alias-brand-primary, currentColor);
}
.dy-tab:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: -2px;
}
.dy-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 220px;
}
.dy-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  font-size: 12px;
}
.dy-notice-error {
  border-color: var(--dsw-alias-state-error-primary, #f85149);
  color: var(--dsw-alias-state-error-primary, #f85149);
}
.dy-notice-text { flex: 1; min-width: 0; word-break: break-word; }
.dy-notice-close {
  appearance: none;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  line-height: 1;
  padding: 2px 4px;
  opacity: 0.7;
}
.dy-notice-close:hover { opacity: 1; }
.dy-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.dy-stat {
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  padding: 13px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dy-stat-value {
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.dy-stat-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dy-stat[data-tone='success'] .dy-stat-value { color: var(--dsw-alias-state-success-primary, #2ea043); }
.dy-stat[data-tone='error'] .dy-stat-value { color: var(--dsw-alias-state-error-primary, #f85149); }
.dy-stat[data-tone='idle'] .dy-stat-value { color: var(--dsw-alias-label-tertiary, inherit); }
.dy-dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
}
.dy-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dy-card-title { margin: 0; font-size: 13px; font-weight: 600; }
.dy-system { display: flex; flex-direction: column; gap: 8px; }
.dy-system-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 12px; }
.dy-system-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); }
.dy-system-value { font-variant-numeric: tabular-nums; }
.dy-system-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.dy-meter {
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  overflow: hidden;
}
.dy-meter-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--dsw-alias-brand-primary, currentColor);
  transition: width 0.3s ease;
}
.dy-meter-secondary { height: 4px; opacity: 0.55; }
.dy-load-list,
.dy-rank-list { display: flex; flex-direction: column; gap: 10px; }
.dy-load-row,
.dy-rank-row { display: flex; flex-direction: column; gap: 3px; }
.dy-load-head,
.dy-rank-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; min-width: 0; }
.dy-load-name,
.dy-rank-name {
  font-weight: 500;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dy-load-meta,
.dy-rank-project {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dy-load-value,
.dy-rank-value {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, inherit);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dy-svc-resources {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-variant-numeric: tabular-nums;
}
.dy-svc-resources .dy-meter { flex: 1 1 120px; max-width: 220px; }
.dy-section { display: flex; flex-direction: column; gap: 8px; }
.dy-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.dy-section-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-variant-numeric: tabular-nums;
}
.dy-card {
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dy-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 10px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.dy-list-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, currentColor);
}
.dy-list-row:first-child { border-top: none; }
.dy-list-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dy-list-title { font-weight: 500; }
.dy-list-meta {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dy-list-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.dy-service-name { font-weight: 500; }
.dy-service-reason {
  margin-top: 2px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, inherit);
  max-width: 320px;
  overflow-wrap: anywhere;
}
.dy-mono {
  font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, inherit);
  overflow-wrap: anywhere;
}
.dy-nowrap { white-space: nowrap; font-variant-numeric: tabular-nums; }
.dy-pill { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.dy-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--dsw-alias-state-idle-primary, #8b949e);
}
.dy-pill[data-status='running'] .dy-dot { background: var(--dsw-alias-state-success-primary, #2ea043); }
.dy-pill[data-status='starting'] .dy-dot,
.dy-pill[data-status='stopping'] .dy-dot { background: var(--dsw-alias-state-warn-primary, #d29922); }
.dy-pill[data-status='crashed'] .dy-dot { background: var(--dsw-alias-state-error-primary, #f85149); }
.dy-pill[data-status='unknown'] .dy-dot { background: var(--dsw-alias-state-warn-primary, #d29922); }
.dy-pill[data-status='crashed'] .dy-pill-label { color: var(--dsw-alias-state-error-primary, #f85149); }
.dy-pill[data-status='unknown'] .dy-pill-label { color: var(--dsw-alias-state-warn-primary, #d29922); }
.dy-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dy-confirm { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); }
.dy-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 6px;
  background: var(--dsw-alias-button-elevated-fill, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.dy-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.dy-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 1px;
}
.dy-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dy-btn-primary {
  background: var(--dsw-alias-button-primary-fill, transparent);
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
}
.dy-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, transparent); }
.dy-btn-danger { color: var(--dsw-alias-state-error-primary, #f85149); }
.dy-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, transparent); }
.dy-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dy-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.dy-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dy-hint { margin: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); }
.dy-textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 72px;
  resize: vertical;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  padding: 8px 10px;
}
.dy-textarea:focus {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: -1px;
  border-color: transparent;
}
.dy-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dy-spacer { flex: 1; }
.dy-scan-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 0;
}
.dy-check-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
}
.dy-check {
  width: 14px;
  height: 14px;
  accent-color: var(--dsw-alias-brand-primary, currentColor);
  cursor: pointer;
}
.dy-candidate {
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.dy-candidate-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dy-candidate-name { font-weight: 550; }
.dy-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  color: var(--dsw-alias-label-tertiary, inherit);
}
.dy-badge-git,
.dy-badge-ok {
  color: var(--dsw-alias-state-success-primary, #2ea043);
  border-color: var(--dsw-alias-state-success-primary, #2ea043);
  text-transform: none;
}
.dy-badge-plain { text-transform: none; }
.dy-badge-warn {
  color: var(--dsw-alias-state-warn-primary, #d29922);
  border-color: var(--dsw-alias-state-warn-primary, #d29922);
  text-transform: none;
}
.dy-badge-danger {
  color: var(--dsw-alias-state-error-primary, #f85149);
  border-color: var(--dsw-alias-state-error-primary, #f85149);
  text-transform: none;
}
.dy-external-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--dsw-alias-state-warn-primary, #d29922);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.dy-external-title { font-size: 12px; font-weight: 600; }
.dy-external-name { font-size: 12px; font-weight: 500; }
.dy-sync-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
}
.dy-external-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px dashed var(--dsw-alias-state-warn-primary, #d29922);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.dy-container {
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.dy-container > summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
}
.dy-project {
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.dy-project-head { display: flex; flex-direction: column; gap: 2px; }
.dy-project-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dy-project-name { font-weight: 600; font-size: 13px; }
.dy-project-path { font-size: 11px; }
.dy-eco { display: flex; flex-direction: column; gap: 6px; padding-top: 4px; }
.dy-eco-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--dsw-alias-border-l1, currentColor);
}
.dy-eco-name { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
.dy-app-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--dsw-alias-border-l1, currentColor);
}
.dy-app-row:first-of-type { border-top: none; }
.dy-app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dy-app-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dy-app-name { font-weight: 500; }
.dy-app-command {
  font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, inherit);
  overflow-wrap: anywhere;
}
/* 服务页：一个项目一张卡片。卡片之间留出明显间隔，项目头自带标签与批量操作，
   避免所有项目糊成一张看不出边界的大表。 */
.dy-svc-page { display: flex; flex-direction: column; gap: 10px; }
.dy-svc-list { display: flex; flex-direction: column; gap: 14px; }
.dy-svc-card {
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: 12px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.dy-svc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1, currentColor);
}
.dy-svc-head-main { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.dy-svc-head-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dy-svc-name { font-weight: 600; font-size: 14px; letter-spacing: -0.1px; }
.dy-svc-path {
  font-size: 11px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dy-svc-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; flex-wrap: wrap; justify-content: flex-end; }
.dy-svc-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, currentColor);
}
.dy-svc-row:first-of-type { border-top: none; }
.dy-svc-row:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.dy-svc-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dy-svc-row-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dy-svc-row-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, inherit);
}
.dy-svc-row-sep { opacity: 0.45; }
.dy-svc-row-status { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; min-width: 96px; }
.dy-svc-uptime { font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dy-svc-row-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dy-tag {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  color: var(--dsw-alias-label-tertiary, inherit);
  white-space: nowrap;
}
.dy-tag-lang { color: var(--dsw-alias-label-secondary, inherit); }
.dy-tag-manager { font-variant-numeric: tabular-nums; }
/* 服务页筛选条：搜索 + 状态芯片 + 语言选择，全部作用于已托管应用。 */
.dy-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 2px 0 6px;
}
.dy-input {
  flex: 1 1 260px;
  min-width: 200px;
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  padding: 6px 10px;
}
.dy-input:focus {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: -1px;
  border-color: transparent;
}
.dy-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dy-chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  font: inherit;
  font-size: 11px;
  line-height: 1.6;
  padding: 2px 11px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  white-space: nowrap;
}
.dy-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.dy-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 1px;
}
.dy-chip[aria-pressed='true'] {
  background: var(--dsw-alias-button-primary-fill, transparent);
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
}
.dy-chip-count { margin-left: 5px; opacity: 0.7; font-variant-numeric: tabular-nums; }
/* 日志弹窗：只在「服务」页就地打开，不切 tab；结构尽量简单，靠 token 上色。 */
.dy-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* 遮罩由文字色派生，避免引入字面色；亮暗主题都能压住背景。 */
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 28%, transparent);
}
.dy-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(960px, 100%);
  max-height: 100%;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: 12px;
  padding: 16px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  box-shadow: 0 12px 32px var(--dsw-alias-border-l2, transparent);
}
.dy-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dy-modal-title-block { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dy-modal-title { font-size: 14px; font-weight: 600; }
.dy-modal-sub { font-size: 11px; }
.dy-modal .dy-logs { max-height: 60vh; }
.dy-reason {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, inherit);
  border-left: 2px solid var(--dsw-alias-border-l2, currentColor);
  padding-left: 8px;
  overflow-wrap: anywhere;
}
.dy-details { font-size: 12px; }
.dy-details summary { cursor: pointer; color: var(--dsw-alias-label-secondary, inherit); }
.dy-details ul { margin: 6px 0 0; padding-left: 18px; }
.dy-details li { color: var(--dsw-alias-label-tertiary, inherit); overflow-wrap: anywhere; }
.dy-logs-toolbar { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.dy-field { display: flex; flex-direction: column; gap: 4px; min-width: 180px; }
.dy-select {
  appearance: auto;
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  padding: 6px 8px;
}
.dy-select:focus { outline: 2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: -1px; }
.dy-logs {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: calc(100vh - 320px);
  min-height: 160px;
  overflow: auto;
}
.dy-empty {
  border: 1px dashed var(--dsw-alias-border-l2, currentColor);
  border-radius: 12px;
  padding: 36px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.dy-empty-title { font-size: 15px; font-weight: 600; }
.dy-empty-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); max-width: 460px; }
.dy-dock-strip {
  box-sizing: border-box;
  /* 与输入框卡片同宽：左右各让出 side-clearance，再受卡片最大宽度限制。
     两者相同时 dock 的左右边缘正好落在输入框边框上。 */
  width: calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px));
  max-width: var(--dsh-composer-card-max-width, 952px);
  margin: 0 auto;
  container-type: inline-size;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.2;
}
.dy-bar {
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 40px;
  padding: 0 6px 0 14px;
  border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, transparent));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, transparent));
  box-shadow: var(--dsw-elevation-soft, none);
  overflow: hidden;
}
/* 左侧竖条是这条 bar 唯一的整块色彩：正常绿、需要关注黄、异常红、全部停止灰。 */
.dy-bar::before {
  content: '';
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--dsw-alias-state-success-primary, #2ea043);
}
.dy-bar[data-tone='warn']::before { background: var(--dsw-alias-state-warn-primary, #d29922); }
.dy-bar[data-tone='error']::before { background: var(--dsw-alias-state-error-primary, #f85149); }
.dy-bar[data-tone='idle']::before { background: var(--dsw-alias-state-idle-primary, #8b949e); }
.dy-bar-brand {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: none;
  min-width: 0;
  color: var(--dsw-alias-label-primary, inherit);
}
.dy-bar-mark { display: inline-flex; color: var(--dsw-alias-label-tertiary, inherit); }
.dy-bar-brand-btn {
  appearance: none;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  cursor: pointer;
}
.dy-bar-brand-btn:hover .dy-bar-mark { color: var(--dsw-alias-label-secondary, inherit); }
.dy-bar-brand-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 2px;
  border-radius: 4px;
}
.dy-bar-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.dy-bar-sep {
  flex: none;
  width: 1px;
  height: 16px;
  background: var(--dsw-alias-border-l1, transparent);
}
.dy-bar-chunk { display: inline-flex; align-items: center; min-width: 0; flex: none; }
.dy-bar-health { gap: 5px; }
.dy-bar-scale { gap: 10px; }
.dy-bar-res { gap: 12px; }
.dy-bar-eco { gap: 5px; flex: 0 1 auto; overflow: hidden; }
.dy-bar-spacer { flex: 1 1 auto; min-width: 4px; }
.dy-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  flex: none;
  white-space: nowrap;
  font-size: 11.5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-interactive-bg-hover, transparent);
}
.dy-chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
.dy-chip[data-tone='success'] {
  background: var(--dsw-alias-state-success-tertiary, #e6faed);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ea043) 14%, transparent);
  color: color-mix(
    in srgb,
    var(--dsw-alias-state-success-primary, #2ea043) 60%,
    var(--dsw-alias-label-primary, #111)
  );
}
.dy-chip[data-tone='error'] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f85149) 14%, transparent);
  color: color-mix(
    in srgb,
    var(--dsw-alias-state-error-primary, #f85149) 62%,
    var(--dsw-alias-label-primary, #111)
  );
}
.dy-chip[data-tone='warn'] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d29922) 16%, transparent);
  color: color-mix(
    in srgb,
    var(--dsw-alias-state-warn-primary, #d29922) 55%,
    var(--dsw-alias-label-primary, #111)
  );
}
.dy-chip[data-tone='neutral'] {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-tertiary, inherit);
}
.dy-metric { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
.dy-metric-value {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
  font-variant-numeric: tabular-nums;
}
.dy-metric-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); }
.dy-res { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.dy-res-label {
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-tertiary, inherit);
}
.dy-res-value {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, inherit);
  font-variant-numeric: tabular-nums;
}
.dy-res-meter {
  width: 34px;
  height: 4px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  overflow: hidden;
}
.dy-res-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--dsw-alias-state-success-primary, #2ea043);
}
.dy-res[data-tone='warn'] .dy-res-fill { background: var(--dsw-alias-state-warn-primary, #d29922); }
.dy-res[data-tone='error'] .dy-res-fill { background: var(--dsw-alias-state-error-primary, #f85149); }
.dy-eco-label {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-tertiary, inherit);
  white-space: nowrap;
}
.dy-tag-eco {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  flex: none;
  white-space: nowrap;
  font-size: 11px;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
}
.dy-tag-eco b { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dy-tag-eco em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, inherit);
}
.dy-tag-eco-count {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-variant-numeric: tabular-nums;
}
.dy-tag-eco-more {
  padding: 0 5px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-variant-numeric: tabular-nums;
}
.dy-bar-actions { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.dy-bar-btn {
  appearance: none;
  border: none;
  background: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  font: inherit;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  white-space: nowrap;
}
.dy-bar-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.dy-bar-icon {
  appearance: none;
  flex: none;
  border: none;
  background: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--dsw-alias-label-tertiary, inherit);
  cursor: pointer;
}
.dy-bar-icon:hover {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.dy-bar-btn:focus-visible,
.dy-bar-icon:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 1px;
}
.dy-chevron {
  display: block;
  width: 7px;
  height: 7px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg) translate(-1px, -1px);
  transition: transform 0.15s ease;
}
.dy-bar-icon[aria-expanded='true'] .dy-chevron {
  transform: rotate(-135deg) translate(-1px, -1px);
}
.dy-bar-state {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, inherit);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dy-bar-error {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11.5px;
  color: var(--dsw-alias-state-error-primary, #f85149);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 展开后的明细：只列需要关注和正在运行的应用，避免 90 个已停止应用淹没有效信息。 */
.dy-dock-panel {
  margin-top: 6px;
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, transparent));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, transparent));
  box-shadow: var(--dsw-elevation-soft, none);
  max-height: 264px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dy-dock-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 7px 5px;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-tertiary, inherit);
  text-transform: uppercase;
}
.dy-dock-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 7px;
  border-radius: 6px;
  font-size: 11.5px;
}
.dy-dock-row:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.dy-dock-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--dsw-alias-state-idle-primary, #8b949e);
}
.dy-dock-dot[data-tone='success'] { background: var(--dsw-alias-state-success-primary, #2ea043); }
.dy-dock-dot[data-tone='warn'] { background: var(--dsw-alias-state-warn-primary, #d29922); }
.dy-dock-dot[data-tone='error'] { background: var(--dsw-alias-state-error-primary, #f85149); }
.dy-dock-row-name {
  flex: 0 1 auto;
  min-width: 0;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dy-dock-row-project {
  flex: 0 1 auto;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dy-dock-row-status { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); }
.dy-dock-row-status[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary, #d29922); }
.dy-dock-row-status[data-tone='error'] { color: var(--dsw-alias-state-error-primary, #f85149); }
.dy-dock-row-meta {
  margin-left: auto;
  flex: none;
  display: flex;
  gap: 8px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dy-dock-panel-empty {
  padding: 8px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, inherit);
  text-align: center;
}
.dy-dock-panel-foot {
  display: flex;
  justify-content: center;
  padding-top: 4px;
  margin-top: 2px;
  border-top: 1px solid var(--dsw-alias-border-l1, transparent);
}
.dy-dock-warn {
  padding: 4px 7px;
  font-size: 10.5px;
  color: var(--dsw-alias-state-warn-primary, #d29922);
}
/* 服务坞页头的"输入框状态条"开关。 */
.dy-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  user-select: none;
}
.dy-switch-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.dy-switch-track {
  position: relative;
  box-sizing: border-box;
  width: 30px;
  height: 18px;
  border-radius: 999px;
  flex: none;
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover, transparent));
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  transition: background 0.15s ease, border-color 0.15s ease;
}
.dy-switch-thumb {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #fff);
  transition: transform 0.15s ease;
}
.dy-switch-input:checked + .dy-switch-track {
  background: var(--dsw-alias-state-business-primary, #4176e6);
  border-color: transparent;
}
.dy-switch-input:checked + .dy-switch-track .dy-switch-thumb { transform: translateX(12px); }
.dy-switch-input:focus-visible + .dy-switch-track {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 2px;
}
.dy-switch-input:disabled + .dy-switch-track { opacity: 0.5; cursor: default; }
.dy-switch-label { white-space: nowrap; }
/* 窄窗口按优先级舍弃低价值块：生态 → 规模 → 资源。健康状态和操作始终保留。 */
@container (max-width: 900px) {
  .dy-bar-eco { display: none; }
}
@container (max-width: 760px) {
  .dy-bar-scale { display: none; }
}
@container (max-width: 640px) {
  .dy-bar-res { display: none; }
}
`;

    /**
     * 左侧栏入口图标。slot 传入 size 与 active；颜色继承宿主文字色。
     * @param {{ size?: number, active?: boolean }} props
     */
    function DockyardIcon(props) {
      const size = props.size ?? 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M2.5 6.5h11M4.5 6.5v4.6c0 .8.6 1.4 1.4 1.4h4.2c.8 0 1.4-.6 1.4-1.4V6.5',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M5.8 6.5V4.4c0-.5.4-.9.9-.9h2.6c.5 0 .9.4.9.9v2.1',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M6.2 9.2h3.6',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * 状态圆点 + 本地化标签。
     * @param {{ status: string, t: (key: string) => string }} props
     */
    function StatusPill(props) {
      const key = STATUS_KEY[props.status] ?? 'statusUnknown';
      return h(
        'span',
        { className: 'dy-pill', 'data-status': props.status },
        h('span', { className: 'dy-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dy-pill-label' }, props.t(key)),
      );
    }

    /**
     * 空状态。空面板必须有明确文案，不能是一片空白。
     * @param {{ title: string, hint?: string, action?: any }} props
     */
    function EmptyState(props) {
      return h(
        'div',
        { className: 'dy-empty' },
        h('div', { className: 'dy-empty-title' }, props.title),
        props.hint ? h('div', { className: 'dy-empty-hint' }, props.hint) : null,
        props.action ?? null,
      );
    }

    /**
     * 概览：统计、需要关注的服务、正在运行的服务。
     * @param {any} props
     */
    function OverviewView(props) {
      const {
        status,
        t,
        onDiscover,
        onLogs,
        onStart,
        busy,
        confirmRemove,
        onRemove,
        onCancelRemove,
      } = props;
      const apps = status.applications;

      if (status.phase === 'loading' && apps.length === 0) {
        return h(EmptyState, { title: t('loading') });
      }
      if (status.phase === 'error' && apps.length === 0) {
        return h(EmptyState, {
          title: t('unavailable'),
          hint: `${t('unavailableHint')}：${status.error}`,
        });
      }

      const counts = { running: 0, crashed: 0, stopped: 0, other: 0 };
      for (const app of apps) {
        if (app.status === 'running') counts.running += 1;
        else if (app.status === 'crashed') counts.crashed += 1;
        else if (app.status === 'stopped') counts.stopped += 1;
        else counts.other += 1;
      }

      const attention = apps.filter(
        (app) =>
          app.status === 'crashed' ||
          app.status === 'unknown' ||
          app.missing === true ||
          app.restartRequired === true,
      );
      const running = apps.filter((app) => app.status === 'running');
      const totalCpu = running.reduce((sum, app) => sum + (app.cpuPercent ?? 0), 0);
      const totalRss = running.reduce((sum, app) => sum + (app.rssBytes ?? 0), 0);

      /** Host 已经按项目聚合；旧 Host 没有该字段时在客户端兜底。 */
      const projects =
        Array.isArray(status.projects) && status.projects.length > 0
          ? status.projects
          : (() => {
              /** @type {Map<string, any>} */
              const groups = new Map();
              for (const app of apps) {
                const key = app.projectId ?? 'unclassified';
                let group = groups.get(key);
                if (!group) {
                  group = {
                    id: key,
                    name: app.projectName ?? t('unclassified'),
                    root: app.projectRoot ?? '',
                    apps: 0,
                    running: 0,
                    cpuPercent: 0,
                    rssBytes: 0,
                  };
                  groups.set(key, group);
                }
                group.apps += 1;
                if (app.status === 'running') {
                  group.running += 1;
                  group.cpuPercent += app.cpuPercent ?? 0;
                  group.rssBytes += app.rssBytes ?? 0;
                }
              }
              return [...groups.values()];
            })();

      const stats = h(
        'div',
        { className: 'dy-stats' },
        [
          ['running', t('statRunning'), counts.running, 'success'],
          ['crashed', t('statCrashed'), counts.crashed, 'error'],
          ['stopped', t('statStopped'), counts.stopped + counts.other, 'idle'],
          ['projects', t('statProjects'), projects.length, 'none'],
          ['cpu', t('statCpu'), formatPercent(totalCpu, '0.0%'), 'none'],
          ['memory', t('statMemory'), formatBytes(totalRss), 'none'],
        ].map(([key, label, value, tone]) =>
          h(
            'div',
            { key, className: 'dy-stat', 'data-tone': tone },
            h('div', { className: 'dy-stat-value' }, String(value)),
            h('div', { className: 'dy-stat-label' }, String(label)),
          ),
        ),
      );

      const system = status.system;
      const systemCard = system
        ? h(
            'div',
            { className: 'dy-card' },
            h(
              'div',
              { className: 'dy-card-head' },
              h('h2', { className: 'dy-card-title' }, t('systemTitle')),
            ),
            (() => {
              const total = Number(system.totalmem) || 0;
              const free = Number(system.freemem) || 0;
              const used = Math.max(0, total - free);
              const usedPercent = total > 0 ? (used / total) * 100 : 0;
              return h(
                'div',
                { className: 'dy-system' },
                h(
                  'div',
                  { className: 'dy-system-row' },
                  h('span', { className: 'dy-system-label' }, t('systemMemory')),
                  h(
                    'span',
                    { className: 'dy-system-value' },
                    `${formatBytes(used)} / ${formatBytes(total)}`,
                  ),
                ),
                h(
                  'div',
                  {
                    className: 'dy-meter',
                    role: 'progressbar',
                    'aria-valuenow': Math.round(usedPercent),
                    'aria-label': t('systemMemory'),
                  },
                  h('div', { className: 'dy-meter-fill', style: { width: `${usedPercent}%` } }),
                ),
                h(
                  'div',
                  { className: 'dy-system-grid' },
                  h(
                    'div',
                    null,
                    h('div', { className: 'dy-system-label' }, t('systemLoad')),
                    h(
                      'div',
                      { className: 'dy-system-value' },
                      (system.loadavg ?? [])
                        .slice(0, 3)
                        .map((value) => Number(value).toFixed(2))
                        .join(' / '),
                    ),
                  ),
                  h(
                    'div',
                    null,
                    h('div', { className: 'dy-system-label' }, t('systemCores')),
                    h('div', { className: 'dy-system-value' }, String(system.cpus ?? '—')),
                  ),
                  h(
                    'div',
                    null,
                    h('div', { className: 'dy-system-label' }, t('systemUptime')),
                    h(
                      'div',
                      { className: 'dy-system-value' },
                      formatUptime((system.uptime ?? 0) * 1000, t),
                    ),
                  ),
                ),
              );
            })(),
          )
        : null;

      const maxProjectCpu = Math.max(1, ...projects.map((project) => project.cpuPercent ?? 0));
      const maxProjectRss = Math.max(1, ...projects.map((project) => project.rssBytes ?? 0));
      const projectLoad =
        projects.length > 0
          ? h(
              'div',
              { className: 'dy-card' },
              h(
                'div',
                { className: 'dy-card-head' },
                h('h2', { className: 'dy-card-title' }, t('projectsTitle')),
                h('span', { className: 'dy-section-count' }, String(projects.length)),
              ),
              h(
                'div',
                { className: 'dy-load-list' },
                ...projects.slice(0, 8).map((project) =>
                  h(
                    'div',
                    { key: project.id, className: 'dy-load-row' },
                    h(
                      'div',
                      { className: 'dy-load-head' },
                      h('span', { className: 'dy-load-name' }, project.name),
                      h(
                        'span',
                        { className: 'dy-load-meta' },
                        format(t('appsRunning'), {
                          running: project.running ?? 0,
                          total: project.apps ?? 0,
                        }),
                      ),
                      h('span', { className: 'dy-spacer' }),
                      h(
                        'span',
                        { className: 'dy-load-value' },
                        `${formatPercent(project.cpuPercent, '—')} · ${formatBytes(project.rssBytes)}`,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dy-meter' },
                      h('div', {
                        className: 'dy-meter-fill',
                        style: {
                          width: `${Math.min(
                            100,
                            ((project.cpuPercent ?? 0) / maxProjectCpu) * 100,
                          )}%`,
                        },
                      }),
                    ),
                    h(
                      'div',
                      { className: 'dy-meter dy-meter-secondary' },
                      h('div', {
                        className: 'dy-meter-fill',
                        style: {
                          width: `${Math.min(
                            100,
                            ((project.rssBytes ?? 0) / maxProjectRss) * 100,
                          )}%`,
                        },
                      }),
                    ),
                  ),
                ),
              ),
            )
          : null;

      const topBy = (field) =>
        [...running]
          .filter((app) => Number.isFinite(app[field]))
          .sort((a, b) => (b[field] ?? 0) - (a[field] ?? 0))
          .slice(0, 5);
      const renderRanking = (title, field, formatter) => {
        const items = topBy(field);
        const max = Math.max(1, ...items.map((app) => app[field] ?? 0));
        return h(
          'div',
          { className: 'dy-card' },
          h('div', { className: 'dy-card-head' }, h('h2', { className: 'dy-card-title' }, title)),
          items.length === 0
            ? h('div', { className: 'dy-hint' }, t('noMetrics'))
            : h(
                'div',
                { className: 'dy-rank-list' },
                ...items.map((app) =>
                  h(
                    'div',
                    { key: app.id, className: 'dy-rank-row' },
                    h(
                      'div',
                      { className: 'dy-rank-head' },
                      h('span', { className: 'dy-rank-name' }, app.name),
                      h(
                        'span',
                        { className: 'dy-rank-project' },
                        app.projectName ?? t('unclassified'),
                      ),
                      h('span', { className: 'dy-spacer' }),
                      h('span', { className: 'dy-rank-value' }, formatter(app[field])),
                    ),
                    h(
                      'div',
                      { className: 'dy-meter' },
                      h('div', {
                        className: 'dy-meter-fill',
                        style: { width: `${Math.min(100, ((app[field] ?? 0) / max) * 100)}%` },
                      }),
                    ),
                  ),
                ),
              ),
        );
      };

      const dashboard = h(
        'div',
        { className: 'dy-dashboard-grid' },
        projectLoad,
        renderRanking(t('topCpuTitle'), 'cpuPercent', (value) => formatPercent(value, '—')),
        renderRanking(t('topMemoryTitle'), 'rssBytes', (value) => formatBytes(value)),
      );

      const warnings =
        status.warnings.length > 0
          ? h(
              'div',
              { className: 'dy-card' },
              h('h2', { className: 'dy-section-title' }, t('warningsTitle')),
              h(
                'ul',
                { className: 'dy-hint', style: { margin: 0, paddingLeft: 18 } },
                ...status.warnings.map((warning, index) => h('li', { key: index }, warning)),
              ),
            )
          : null;

      const attentionSection =
        attention.length > 0
          ? h(
              'section',
              { className: 'dy-section' },
              h(
                'h2',
                { className: 'dy-section-title' },
                t('attentionTitle'),
                h('span', { className: 'dy-section-count' }, String(attention.length)),
              ),
              h(
                'div',
                { className: 'dy-list' },
                ...attention.map((app) =>
                  h(
                    'div',
                    { key: app.id, className: 'dy-list-row' },
                    h(
                      'div',
                      { className: 'dy-list-main' },
                      h('span', { className: 'dy-list-title' }, app.name),
                      h(
                        'span',
                        { className: 'dy-list-meta' },
                        `${app.missing ? '[失联] ' : ''}${
                          app.restartRequired ? '[需重启] ' : ''
                        }${app.statusReason || app.command} · ${app.dir}`,
                      ),
                    ),
                    h(StatusPill, { status: app.status, t }),
                    h(
                      'div',
                      { className: 'dy-list-actions' },
                      confirmRemove === app.id
                        ? h(
                            React.Fragment,
                            null,
                            h('span', { className: 'dy-confirm' }, t('removeConfirm')),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dy-btn dy-btn-danger',
                                disabled: busy !== '',
                                onClick: () => onRemove(app.id),
                              },
                              t('actionRemove'),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dy-btn',
                                onClick: onCancelRemove,
                              },
                              t('removeCancel'),
                            ),
                          )
                        : h(
                            React.Fragment,
                            null,
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dy-btn dy-btn-primary',
                                disabled: busy !== '',
                                onClick: () => onStart(app.id),
                              },
                              t('actionStart'),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dy-btn',
                                onClick: () => onLogs(app.id),
                              },
                              t('actionLogs'),
                            ),
                          ),
                    ),
                  ),
                ),
              ),
            )
          : null;

      const runningSection =
        running.length > 0
          ? h(
              'section',
              { className: 'dy-section' },
              h(
                'h2',
                { className: 'dy-section-title' },
                t('runningTitle'),
                h('span', { className: 'dy-section-count' }, String(running.length)),
              ),
              h(
                'div',
                { className: 'dy-list' },
                ...running.map((app) =>
                  h(
                    'div',
                    { key: app.id, className: 'dy-list-row' },
                    h(
                      'div',
                      { className: 'dy-list-main' },
                      h('span', { className: 'dy-list-title' }, app.name),
                      h(
                        'span',
                        { className: 'dy-list-meta' },
                        `${formatUptime(app.uptimeMs, t)} · ${formatPercent(
                          app.cpuPercent,
                          '—',
                        )} · ${formatBytes(app.rssBytes)} · ${app.command} ${
                          Array.isArray(app.args) ? app.args.join(' ') : ''
                        } · ${app.dir}`,
                      ),
                    ),
                    h(StatusPill, { status: app.status, t }),
                    h(
                      'div',
                      { className: 'dy-list-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dy-btn',
                          onClick: () => onLogs(app.id),
                        },
                        t('actionLogs'),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : null;

      const empty =
        apps.length === 0
          ? h(EmptyState, {
              title: t('emptyTitle'),
              hint: t('emptyHint'),
              action: h(
                'button',
                { type: 'button', className: 'dy-btn dy-btn-primary', onClick: onDiscover },
                t('emptyAction'),
              ),
            })
          : null;

      return h(
        React.Fragment,
        null,
        stats,
        systemCard,
        dashboard,
        warnings,
        attentionSection,
        runningSection,
        empty,
      );
    }

    /**
     * 服务列表：按项目分组；每组内每行带状态、命令、目录、运行时长与操作。
     * @param {any} props
     */
    function ServicesView(props) {
      const {
        status,
        t,
        busy,
        act,
        onRemove,
        confirmRemove,
        setConfirmRemove,
        confirmRemoveProject,
        setConfirmRemoveProject,
        onRemoveProject,
        onProjectAction,
        onLogs,
        onDiscover,
        query,
        setQuery,
        statusFilter,
        setStatusFilter,
        languageFilter,
        setLanguageFilter,
        sync,
        onSync,
        autoTakeover,
        lastAutoTakeover,
        external,
        onTakeoverHosted,
      } = props;
      const apps = status.applications;

      if (status.phase === 'loading' && apps.length === 0) {
        return h(EmptyState, { title: t('loading') });
      }
      if (apps.length === 0) {
        return h(EmptyState, {
          title: t('servicesEmpty'),
          action: h(
            'button',
            { type: 'button', className: 'dy-btn dy-btn-primary', onClick: onDiscover },
            t('emptyAction'),
          ),
        });
      }

      /** @type {Map<string, { key: string, name: string, root: string, apps: any[] }>} */
      const groups = new Map();
      for (const app of apps) {
        const key = app.projectId ?? 'unclassified';
        let group = groups.get(key);
        if (!group) {
          group = {
            key,
            name: app.projectName ?? t('unclassified'),
            root: app.projectRoot ?? '',
            apps: [],
          };
          groups.set(key, group);
        }
        group.apps.push(app);
      }
      const ordered = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

      /** 运行中与启动中都算"活着"；批量操作据此决定目标集合。 */
      const isActive = (app) => app.status === 'running' || app.status === 'starting';

      /**
       * 项目头部的语言标签：取项目内各应用语言的并集，去重后排序。
       * @param {any[]} list
       */
      const languagesOf = (list) => {
        const seen = new Set();
        for (const app of list) {
          const language = typeof app.language === 'string' ? app.language.trim() : '';
          if (language !== '') seen.add(language);
        }
        return [...seen].sort((a, b) => a.localeCompare(b));
      };

      /**
       * 应用标签：语言与包管理器分开给出。两者都缺失时退回生态名，
       * 再没有就明确写"未知语言"，不猜一个看起来合理的值。
       * @param {any} app
       */
      const renderAppTags = (app) => {
        const tags = [];
        if (typeof app.language === 'string' && app.language !== '') {
          tags.push(
            h(
              'span',
              { key: 'language', className: 'dy-tag dy-tag-lang', title: t('tagLanguage') },
              app.language,
            ),
          );
        }
        if (typeof app.manager === 'string' && app.manager !== '') {
          tags.push(
            h(
              'span',
              { key: 'manager', className: 'dy-tag dy-tag-manager', title: t('tagManager') },
              app.manager,
            ),
          );
        }
        if (tags.length === 0) {
          tags.push(
            h(
              'span',
              { key: 'fallback', className: 'dy-tag' },
              app.ecosystemName || t('languageUnknown'),
            ),
          );
        }
        return tags;
      };

      /**
       * @param {any} app
       */
      function renderRow(app) {
        const running = isActive(app);
        const removeOpen = confirmRemove === app.id;
        const command = `${app.command ?? ''} ${
          Array.isArray(app.args) ? app.args.join(' ') : ''
        }`.trim();
        return h(
          'div',
          { key: app.id, className: 'dy-svc-row' },
          h(
            'div',
            { className: 'dy-svc-row-main' },
            h(
              'div',
              { className: 'dy-svc-row-title' },
              h('span', { className: 'dy-service-name' }, app.name),
              ...renderAppTags(app),
              app.missing
                ? h('span', { className: 'dy-badge dy-badge-danger' }, t('missingBadge'))
                : null,
              app.restartRequired
                ? h('span', { className: 'dy-badge dy-badge-warn' }, t('restartRequiredBadge'))
                : null,
            ),
            h(
              'div',
              { className: 'dy-svc-row-meta' },
              h('span', { className: 'dy-mono', title: command }, command || t('never')),
              h('span', { className: 'dy-svc-row-sep' }, '·'),
              h('span', { className: 'dy-mono', title: app.dir }, app.dir),
            ),
            running
              ? h(
                  'div',
                  { className: 'dy-svc-resources' },
                  h('span', null, `CPU ${formatPercent(app.cpuPercent, '—')}`),
                  h('span', null, `内存 ${formatBytes(app.rssBytes)}`),
                  Number.isFinite(app.cpuPercent)
                    ? h(
                        'div',
                        { className: 'dy-meter' },
                        h('div', {
                          className: 'dy-meter-fill',
                          style: { width: `${Math.min(100, app.cpuPercent)}%` },
                        }),
                      )
                    : null,
                )
              : null,
            /** 只有异常/过渡态才需要解释；"已加入管理列表，尚未启动。"这种
             * 恒定文案挂在 152 行上是纯噪音，状态本身已经说清了。 */
            app.statusReason && app.status !== 'stopped'
              ? h('div', { className: 'dy-service-reason' }, app.statusReason)
              : null,
          ),
          h(
            'div',
            { className: 'dy-svc-row-status' },
            h(StatusPill, { status: app.status, t }),
            /** 没在跑就没有时长可显示，不要用一排"—"占位。 */
            typeof app.uptimeMs === 'number'
              ? h('span', { className: 'dy-svc-uptime' }, formatUptime(app.uptimeMs, t))
              : null,
          ),
          h(
            'div',
            { className: 'dy-svc-row-actions' },
            running
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dy-btn',
                      disabled: busy !== '',
                      onClick: () => act('stop', { id: app.id }, `stop:${app.id}`),
                    },
                    t('actionStop'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dy-btn',
                      disabled: busy !== '',
                      onClick: () => act('restart', { id: app.id }, `restart:${app.id}`),
                    },
                    t('actionRestart'),
                  ),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dy-btn',
                    disabled: busy !== '' || app.missing === true,
                    title: app.missing ? t('missingBadge') : undefined,
                    onClick: () => act('start', { id: app.id }, `start:${app.id}`),
                  },
                  t('actionStart'),
                ),
            h(
              'button',
              { type: 'button', className: 'dy-btn', onClick: () => onLogs(app.id) },
              t('actionLogs'),
            ),
            removeOpen
              ? h(
                  React.Fragment,
                  null,
                  h('span', { className: 'dy-confirm' }, t('removeConfirm')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dy-btn dy-btn-danger',
                      disabled: busy !== '',
                      onClick: () => onRemove(app.id),
                    },
                    t('actionRemove'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dy-btn',
                      onClick: () => setConfirmRemove(''),
                    },
                    t('removeCancel'),
                  ),
                )
              : running
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dy-btn dy-btn-danger',
                      disabled: busy !== '',
                      onClick: () => setConfirmRemove(app.id),
                    },
                    t('actionRemove'),
                  ),
          ),
        );
      }

      /** 语言筛选项来自已托管应用的真实语言，去重排序。 */
      const languages = [
        ...new Set(
          apps.flatMap((app) =>
            typeof app.language === 'string' && app.language !== '' ? [app.language] : [],
          ),
        ),
      ].sort((a, b) => a.localeCompare(b));

      const countByFilter = { all: apps.length, running: 0, crashed: 0, stopped: 0 };
      for (const app of apps) {
        if (isActive(app)) countByFilter.running += 1;
        else if (app.status === 'crashed' || app.status === 'unknown') countByFilter.crashed += 1;
        else countByFilter.stopped += 1;
      }

      const matchesStatus = (app) => {
        if (statusFilter === 'running') return isActive(app);
        if (statusFilter === 'crashed') return app.status === 'crashed' || app.status === 'unknown';
        if (statusFilter === 'stopped') {
          return !isActive(app) && app.status !== 'crashed' && app.status !== 'unknown';
        }
        return true;
      };
      const matchesLanguage = (app) => languageFilter === 'all' || app.language === languageFilter;
      const appHaystack = (app) =>
        [
          app.name,
          app.projectName,
          app.dir,
          app.command,
          ...(Array.isArray(app.args) ? app.args : []),
          app.language,
          app.manager,
          app.ecosystemName,
        ]
          .filter((value) => typeof value === 'string' && value !== '')
          .join(' ')
          .toLowerCase();

      const needle = query.trim().toLowerCase();
      const groupMatchesQuery = (group) =>
        needle === '' || `${group.name} ${group.root}`.toLowerCase().includes(needle);

      /** 项目名/路径命中时展示该项目下全部（受状态与语言约束的）应用；
       * 只有单个应用命中时才裁剪到命中的应用，避免"搜到了却看不到"。 */
      const visibleGroups = ordered.flatMap((group) => {
        const base = group.apps.filter((app) => matchesStatus(app) && matchesLanguage(app));
        if (base.length === 0) return [];
        if (groupMatchesQuery(group)) return [{ ...group, apps: base }];
        const matched = base.filter((app) => appHaystack(app).includes(needle));
        return matched.length === 0 ? [] : [{ ...group, apps: matched }];
      });

      const filtersActive = query !== '' || statusFilter !== 'all' || languageFilter !== 'all';
      const clearFilters = () => {
        setQuery('');
        setStatusFilter('all');
        setLanguageFilter('all');
      };
      const STATUS_FILTERS = [
        ['all', 'filterAll'],
        ['running', 'statusRunning'],
        ['crashed', 'filterCrashedShort'],
        ['stopped', 'statusStopped'],
      ];

      const syncText = sync
        ? `${new Date(sync.at).toLocaleTimeString()} · ${format(t('syncSummary'), {
            added: sync.added,
            changed: sync.changed,
            missing: sync.missing,
          })}`
        : t('syncNever');

      const externalByRoot = new Map();
      for (const item of external?.processes ?? []) {
        if (typeof item.root !== 'string') continue;
        externalByRoot.set(item.root, (externalByRoot.get(item.root) ?? 0) + 1);
      }
      const externalProjects = (status.projects ?? []).filter(
        (project) => (externalByRoot.get(project.root) ?? 0) > 0,
      );

      return h(
        'div',
        { className: 'dy-svc-page' },
        h(
          'div',
          { className: 'dy-sync-bar' },
          h('span', { className: 'dy-hint' }, syncText),
          h(
            'span',
            { className: 'dy-tag' },
            autoTakeover ? t('autoTakeoverOn') : t('autoTakeoverOff'),
          ),
          lastAutoTakeover
            ? h(
                'span',
                { className: 'dy-hint' },
                format(t('autoTakenOver'), { name: lastAutoTakeover.projectName }),
              )
            : null,
          h('span', { className: 'dy-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dy-btn',
              disabled: busy !== '',
              onClick: onSync,
            },
            busy === 'sync' ? t('syncing') : t('syncNow'),
          ),
        ),
        externalProjects.length > 0
          ? h(
              'div',
              { className: 'dy-external-panel' },
              h(
                'div',
                { className: 'dy-external-title' },
                format(t('externalCount'), {
                  count: externalProjects.reduce(
                    (sum, project) => sum + (externalByRoot.get(project.root) ?? 0),
                    0,
                  ),
                }),
              ),
              ...externalProjects.map((project) =>
                h(
                  'div',
                  { key: project.id, className: 'dy-external-row' },
                  h('span', { className: 'dy-external-name' }, project.name),
                  h(
                    'span',
                    { className: 'dy-hint' },
                    format(t('externalCount'), {
                      count: externalByRoot.get(project.root) ?? 0,
                    }),
                  ),
                  h('span', { className: 'dy-spacer' }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dy-btn dy-btn-primary',
                      disabled: busy !== '',
                      onClick: () => onTakeoverHosted(project),
                    },
                    busy === `takeover:${project.id}` ? t('takingOver') : t('takeoverProject'),
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dy-filters', role: 'search' },
          h('input', {
            type: 'search',
            className: 'dy-input',
            placeholder: t('filterSearch'),
            'aria-label': t('filterSearch'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'div',
            { className: 'dy-chips', role: 'group', 'aria-label': t('filterStatusLabel') },
            ...STATUS_FILTERS.map(([value, labelKey]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'dy-chip',
                  'aria-pressed': statusFilter === value ? 'true' : 'false',
                  onClick: () => setStatusFilter(value),
                },
                t(labelKey),
                h('span', { className: 'dy-chip-count' }, String(countByFilter[value])),
              ),
            ),
          ),
          h(
            'select',
            {
              className: 'dy-select',
              'aria-label': t('filterLanguageLabel'),
              value: languageFilter,
              onChange: (event) => setLanguageFilter(event.target.value),
            },
            h('option', { value: 'all' }, `${t('filterLanguageLabel')}：${t('filterAll')}`),
            ...languages.map((language) =>
              h('option', { key: language, value: language }, language),
            ),
          ),
          h(
            'span',
            { className: 'dy-hint' },
            format(t('filterSummary'), { shown: visibleGroups.length, total: ordered.length }),
          ),
          filtersActive
            ? h(
                'button',
                { type: 'button', className: 'dy-btn dy-btn-ghost', onClick: clearFilters },
                t('filterClear'),
              )
            : null,
        ),
        visibleGroups.length === 0
          ? h(EmptyState, {
              title: t('filterEmpty'),
              action: h(
                'button',
                { type: 'button', className: 'dy-btn', onClick: clearFilters },
                t('filterClear'),
              ),
            })
          : h(
              'div',
              { className: 'dy-svc-list' },
              ...visibleGroups.map((group) => {
                const runningCount = group.apps.filter((app) => app.status === 'running').length;
                const startable = group.apps.filter((app) => !isActive(app) && !app.missing);
                const stoppable = group.apps.filter((app) => isActive(app));
                return h(
                  'section',
                  { key: group.key, className: 'dy-svc-card' },
                  h(
                    'div',
                    { className: 'dy-svc-head' },
                    h(
                      'div',
                      { className: 'dy-svc-head-main' },
                      h(
                        'div',
                        { className: 'dy-svc-head-title' },
                        h('span', { className: 'dy-svc-name' }, group.name),
                        h(
                          'span',
                          { className: 'dy-tag' },
                          format(t('projectApps'), { count: group.apps.length }),
                        ),
                        h(
                          'span',
                          { className: 'dy-tag' },
                          format(t('projectRunningOfTotal'), {
                            running: runningCount,
                            total: group.apps.length,
                          }),
                        ),
                        h(
                          'span',
                          { className: 'dy-tag' },
                          `CPU ${formatPercent(
                            group.apps.reduce(
                              (sum, app) =>
                                sum + (app.status === 'running' ? (app.cpuPercent ?? 0) : 0),
                              0,
                            ),
                            '—',
                          )}`,
                        ),
                        h(
                          'span',
                          { className: 'dy-tag' },
                          `内存 ${formatBytes(
                            group.apps.reduce(
                              (sum, app) =>
                                sum + (app.status === 'running' ? (app.rssBytes ?? 0) : 0),
                              0,
                            ),
                          )}`,
                        ),
                        ...languagesOf(group.apps).map((language) =>
                          h(
                            'span',
                            { key: `language:${language}`, className: 'dy-tag dy-tag-lang' },
                            language,
                          ),
                        ),
                      ),
                      group.root
                        ? h(
                            'span',
                            { className: 'dy-mono dy-svc-path', title: group.root },
                            group.root,
                          )
                        : null,
                    ),
                    h(
                      'div',
                      { className: 'dy-svc-actions' },
                      /** 只渲染当前可执行的批量动作：59 个项目各挂一排灰掉的按钮
                       * 比没有按钮更乱，而"能不能点"已经由有没有就不言自明。 */
                      startable.length > 0
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'dy-btn dy-btn-ghost',
                              disabled: busy !== '',
                              onClick: () => onProjectAction('start', startable, group.key),
                            },
                            t('actionStartAll'),
                          )
                        : null,
                      stoppable.length > 0
                        ? h(
                            React.Fragment,
                            null,
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dy-btn dy-btn-ghost',
                                disabled: busy !== '',
                                onClick: () => onProjectAction('stop', stoppable, group.key),
                              },
                              t('actionStopAll'),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dy-btn dy-btn-ghost',
                                disabled: busy !== '',
                                onClick: () => onProjectAction('restart', stoppable, group.key),
                              },
                              t('actionRestartAll'),
                            ),
                          )
                        : null,
                      group.key !== 'unclassified'
                        ? confirmRemoveProject === group.key
                          ? h(
                              React.Fragment,
                              null,
                              h('span', { className: 'dy-confirm' }, t('removeProjectHint')),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dy-btn dy-btn-danger',
                                  disabled: busy !== '',
                                  onClick: () => onRemoveProject(group.key),
                                },
                                t('removeProject'),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dy-btn',
                                  onClick: () => setConfirmRemoveProject(''),
                                },
                                t('cancel'),
                              ),
                            )
                          : h(
                              'button',
                              {
                                type: 'button',
                                className: 'dy-btn dy-btn-ghost dy-btn-danger',
                                disabled: busy !== '',
                                onClick: () => setConfirmRemoveProject(group.key),
                              },
                              t('removeProject'),
                            )
                        : null,
                    ),
                  ),
                  ...group.apps.map(renderRow),
                );
              }),
            ),
      );
    }

    /**
     * 项目来源徽标：git 是项目的事实依据，无 git 但有清单的项目单独标注。
     * @param {{ t: (key: string) => string, source: string }} props
     */
    function SourceBadge(props) {
      const isGit = props.source === 'git';
      return h(
        'span',
        { className: `dy-badge ${isGit ? 'dy-badge-git' : 'dy-badge-plain'}` },
        props.t(isGit ? 'projectGit' : 'projectNoGit'),
      );
    }

    /**
     * 可运行应用一行。托管在项目级完成，这里只展示应用本身与是否已托管。
     * @param {any} props
     */
    function AppRow(props) {
      const { t, app } = props;
      const command = `${app.command ?? ''} ${
        Array.isArray(app.args) ? app.args.join(' ') : ''
      }`.trim();
      return h(
        'div',
        { className: 'dy-app-row' },
        h(
          'div',
          { className: 'dy-app-main' },
          h(
            'div',
            { className: 'dy-app-head' },
            h('span', { className: 'dy-app-name' }, app.name),
            app.alreadyAdded
              ? h('span', { className: 'dy-badge dy-badge-ok' }, t('discoverAdded'))
              : null,
          ),
          h('div', { className: 'dy-app-command' }, command),
          h('div', { className: 'dy-mono' }, app.dir),
          app.reason ? h('div', { className: 'dy-reason' }, app.reason) : null,
        ),
      );
    }

    /**
     * 一个项目卡片：项目头 + 生态分组 + 应用行。
     * 托管单位是项目：勾选或点“托管项目”会把项目下所有应用一起加入托管。
     * 单生态项目不渲染分组标题，避免多一层视觉噪音。
     * @param {any} props
     */
    function ProjectCard(props) {
      const {
        t,
        project,
        busy,
        selected,
        onToggleSelected,
        onHostProject,
        externalCount,
        onTakeover,
      } = props;
      const groups = Array.isArray(project.ecosystems) ? project.ecosystems : [];
      const apps = groups.flatMap((group) => (Array.isArray(group.apps) ? group.apps : []));
      const hosted = apps.filter((app) => app.alreadyAdded).length;
      const allHosted = apps.length > 0 && hosted === apps.length;
      const hostLabel = hosted > 0 ? t('hostProjectPartial') : t('hostProject');
      return h(
        'div',
        { className: 'dy-project' },
        h(
          'div',
          { className: 'dy-project-head' },
          h(
            'div',
            { className: 'dy-project-title' },
            apps.length > 0
              ? h('input', {
                  type: 'checkbox',
                  className: 'dy-check',
                  checked: selected,
                  'aria-label': `${t('hostProject')} ${project.name}`,
                  onChange: (event) => onToggleSelected(project.id, event.target.checked),
                })
              : null,
            h('span', { className: 'dy-project-name' }, project.name),
            h(SourceBadge, { t, source: project.source }),
            h(
              'span',
              { className: 'dy-section-count' },
              format(t('projectApps'), { count: apps.length }),
            ),
            allHosted
              ? h('span', { className: 'dy-badge dy-badge-ok' }, t('hostedAll'))
              : hosted > 0
                ? h(
                    'span',
                    { className: 'dy-badge' },
                    format(t('hostedCount'), { added: hosted, count: apps.length }),
                  )
                : null,
            h('span', { className: 'dy-spacer' }),
            apps.length > 0 && !allHosted
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dy-btn dy-btn-primary',
                    disabled: busy !== '',
                    onClick: () => onHostProject(project),
                  },
                  hostLabel,
                )
              : null,
          ),
          h('div', { className: 'dy-mono dy-project-path' }, project.root),
        ),
        externalCount > 0
          ? h(
              'div',
              { className: 'dy-external-row' },
              h(
                'span',
                { className: 'dy-badge dy-badge-warn' },
                format(t('externalCount'), { count: externalCount }),
              ),
              h('span', { className: 'dy-hint' }, t('externalHint')),
              h('span', { className: 'dy-spacer' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dy-btn dy-btn-primary',
                  disabled: busy !== '',
                  onClick: () => onTakeover(project),
                },
                busy === `takeover:${project.id}` ? t('takingOver') : t('takeoverProject'),
              ),
            )
          : null,
        apps.length === 0 ? h('div', { className: 'dy-hint' }, t('discoverNoApps')) : null,
        ...(groups.length <= 1
          ? (groups[0]?.apps ?? []).map((app) => h(AppRow, { key: app.id, t, app }))
          : groups.map((group) =>
              h(
                'div',
                { key: group.id, className: 'dy-eco' },
                h(
                  'div',
                  { className: 'dy-eco-head' },
                  h('span', { className: 'dy-eco-name' }, group.name),
                  h('span', { className: 'dy-section-count' }, String(group.apps.length)),
                ),
                ...group.apps.map((app) => h(AppRow, { key: app.id, t, app })),
              ),
            )),
        Array.isArray(project.diagnostics) && project.diagnostics.length > 0
          ? h(
              'details',
              { className: 'dy-details' },
              h('summary', null, `${t('discoverDiagnostics')}（${project.diagnostics.length}）`),
              h(
                'ul',
                null,
                ...project.diagnostics
                  .slice(0, 10)
                  .map((item, index) => h('li', { key: index }, `${item.path} — ${item.message}`)),
              ),
            )
          : null,
      );
    }

    /**
     * 发现：点击扫描 → 系统文件夹选择 → 自动扫描 → 按项目/生态/应用展示。
     * 没有选择器的环境才展开手动输入。
     * @param {any} props
     */
    function DiscoverView(props) {
      const {
        t,
        canPick,
        manualRoots,
        setManualRoots,
        onScan,
        onFallbackScan,
        scanning,
        picking,
        scan,
        busy,
        selectedProjects,
        onToggleSelected,
        onToggleAll,
        onHostProject,
        onHostSelected,
        onRequestHostAll,
        confirmHostAll,
        onConfirmHostAll,
        onCancelHostAll,
        external,
        onTakeoverProject,
      } = props;

      const projects = scan && Array.isArray(scan.projects) ? scan.projects : [];
      const apps = projects.flatMap((project) =>
        (project.ecosystems ?? []).flatMap((group) => group.apps ?? []),
      );
      const projectsWithApps = projects.filter((project) => (project.ecosystems ?? []).length > 0);
      const projectsWithoutApps = projects.filter(
        (project) => (project.ecosystems ?? []).length === 0,
      );
      /** 外部进程按项目根目录计数，供项目卡展示“接管”。 */
      const externalByRoot = new Map();
      for (const item of external?.processes ?? []) {
        if (typeof item.root !== 'string') continue;
        externalByRoot.set(item.root, (externalByRoot.get(item.root) ?? 0) + 1);
      }
      const selectedCount = projectsWithApps.filter((project) =>
        selectedProjects.has(project.id),
      ).length;
      const allSelected = projectsWithApps.length > 0 && selectedCount === projectsWithApps.length;
      /** @type {Map<string, { container: any, projects: any[] }>} */
      const containers = new Map();
      const standalone = [];
      for (const project of projectsWithApps) {
        if (project.container) {
          const id = project.container.id;
          const entry = containers.get(id) ?? { container: project.container, projects: [] };
          entry.projects.push(project);
          containers.set(id, entry);
        } else {
          standalone.push(project);
        }
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dy-card' },
          h('div', { className: 'dy-label' }, t('discoverTitle')),
          h('p', { className: 'dy-hint' }, t('discoverHint')),
          canPick
            ? h(
                'div',
                { className: 'dy-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dy-btn dy-btn-primary',
                    disabled: scanning || picking,
                    onClick: onScan,
                  },
                  scanning || picking ? t('discoverScanning') : t('discoverScan'),
                ),
              )
            : h(
                'details',
                { className: 'dy-details', open: true },
                h('summary', null, t('discoverManual')),
                h('textarea', {
                  className: 'dy-textarea',
                  value: manualRoots,
                  spellCheck: false,
                  placeholder: t('discoverPlaceholder'),
                  onChange: (event) => setManualRoots(event.target.value),
                  'aria-label': t('discoverManual'),
                }),
                h(
                  'div',
                  { className: 'dy-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dy-btn dy-btn-primary',
                      disabled: scanning,
                      onClick: onFallbackScan,
                    },
                    scanning ? t('discoverScanning') : t('discoverScan'),
                  ),
                ),
              ),
        ),
        scan
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dy-row' },
                h(
                  'span',
                  { className: 'dy-label' },
                  format(t('discoverSummary'), {
                    dirs: scan.scannedDirs ?? 0,
                    projects: projects.length,
                    apps: apps.length,
                  }),
                ),
              ),
              external?.error
                ? h('div', { className: 'dy-notice dy-notice-error' }, external.error)
                : null,
              projectsWithApps.length > 0
                ? h(
                    'div',
                    { className: 'dy-scan-toolbar' },
                    h(
                      'label',
                      { className: 'dy-check-label' },
                      h('input', {
                        type: 'checkbox',
                        className: 'dy-check',
                        checked: allSelected,
                        onChange: (event) => onToggleAll(event.target.checked),
                      }),
                      t('selectAll'),
                    ),
                    h(
                      'span',
                      { className: 'dy-hint' },
                      format(t('selectedCount'), { count: selectedCount }),
                    ),
                    h('span', { className: 'dy-spacer' }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dy-btn dy-btn-primary',
                        disabled: selectedCount === 0 || busy !== '',
                        onClick: onHostSelected,
                      },
                      `${t('hostSelected')} (${selectedCount})`,
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dy-btn',
                        disabled: busy !== '',
                        onClick: onRequestHostAll,
                      },
                      t('hostAll'),
                    ),
                  )
                : null,
              confirmHostAll
                ? h(
                    'div',
                    { className: 'dy-notice dy-notice-info' },
                    h(
                      'span',
                      { className: 'dy-notice-text' },
                      format(t('hostAllConfirm'), {
                        projects: projectsWithApps.length,
                        apps: apps.length,
                      }),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dy-btn dy-btn-primary',
                        onClick: onConfirmHostAll,
                      },
                      t('hostConfirm'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'dy-btn', onClick: onCancelHostAll },
                      t('cancel'),
                    ),
                  )
                : null,
              projects.length === 0
                ? h('p', { className: 'dy-hint' }, t('discoverNoProjects'))
                : h(
                    React.Fragment,
                    null,
                    ...standalone.map((project) =>
                      h(ProjectCard, {
                        key: project.id,
                        t,
                        project,
                        busy,
                        selected: selectedProjects.has(project.id),
                        onToggleSelected,
                        onHostProject,
                        externalCount: externalByRoot.get(project.root) ?? 0,
                        onTakeover: onTakeoverProject,
                      }),
                    ),
                    ...[...containers.values()].map((entry) =>
                      h(
                        'details',
                        { key: entry.container.id, className: 'dy-container', open: true },
                        h(
                          'summary',
                          null,
                          `${entry.container.name} · ${format(t('containerProjects'), {
                            count: entry.projects.length,
                          })}`,
                        ),
                        ...entry.projects.map((project) =>
                          h(ProjectCard, {
                            key: project.id,
                            t,
                            project,
                            busy,
                            selected: selectedProjects.has(project.id),
                            onToggleSelected,
                            onHostProject,
                            externalCount: externalByRoot.get(project.root) ?? 0,
                            onTakeover: onTakeoverProject,
                          }),
                        ),
                      ),
                    ),
                  ),
              projectsWithoutApps.length > 0
                ? h(
                    'details',
                    { className: 'dy-details', open: projectsWithApps.length === 0 },
                    h(
                      'summary',
                      null,
                      `${t('discoverNoAppProjects')}（${projectsWithoutApps.length}）`,
                    ),
                    ...projectsWithoutApps.map((project) =>
                      h(ProjectCard, {
                        key: project.id,
                        t,
                        project,
                        busy,
                        selected: selectedProjects.has(project.id),
                        onToggleSelected,
                        onHostProject,
                        externalCount: externalByRoot.get(project.root) ?? 0,
                        onTakeover: onTakeoverProject,
                      }),
                    ),
                  )
                : null,
              Array.isArray(scan.diagnostics) && scan.diagnostics.length > 0
                ? h(
                    'details',
                    { className: 'dy-details' },
                    h('summary', null, `${t('discoverDiagnostics')}（${scan.diagnostics.length}）`),
                    h(
                      'ul',
                      null,
                      ...scan.diagnostics
                        .slice(0, 30)
                        .map((item, index) =>
                          h('li', { key: index }, `${item.path} — ${item.message}`),
                        ),
                    ),
                  )
                : null,
            )
          : null,
      );
    }

    /**
     * 日志：选择服务与行数，显示最近日志。
     * @param {any} props
     */
    /**
     * 日志正文 + 行数/刷新工具条。整页「日志」tab 与就地弹窗共用这一块，
     * 保证两处行数、来源提示、空状态与自动跟随行为完全一致。
     * @param {{ t: Function, idPrefix: string, lines: number, setLines: Function, logState: any, refreshLogs: Function, logRef: any }} props
     */
    function LogPanel(props) {
      const { t, idPrefix, lines, setLines, logState, refreshLogs, logRef } = props;
      const sourceKey =
        logState.source === 'buffer'
          ? 'sourceBuffer'
          : logState.source === 'file'
            ? 'sourceFile'
            : 'sourceNone';
      const linesId = `${idPrefix}-lines`;
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dy-logs-toolbar' },
          h('span', { className: 'dy-hint' }, `${t('logsSource')}：${t(sourceKey)}`),
          h('span', { className: 'dy-spacer' }),
          h(
            'div',
            { className: 'dy-field', style: { minWidth: 100 } },
            h('label', { className: 'dy-label', htmlFor: linesId }, t('logsLines')),
            h(
              'select',
              {
                id: linesId,
                className: 'dy-select',
                value: String(lines),
                onChange: (event) => setLines(Number(event.target.value)),
              },
              ...[100, 200, 500, 1000].map((value) =>
                h('option', { key: value, value: String(value) }, String(value)),
              ),
            ),
          ),
          h(
            'button',
            { type: 'button', className: 'dy-btn', onClick: refreshLogs },
            t('logsRefresh'),
          ),
        ),
        logState.phase === 'error'
          ? h(
              'div',
              { className: 'dy-notice dy-notice-error', role: 'alert' },
              h('span', { className: 'dy-notice-text' }, logState.error),
            )
          : null,
        h(
          'pre',
          { className: 'dy-logs', ref: logRef, 'aria-live': 'polite' },
          logState.lines.length > 0 ? logState.lines.join('\n') : t('logsEmpty'),
        ),
      );
    }

    /**
     * 整页「日志」tab：先选服务，再复用 LogPanel。
     * @param {{ t: Function, apps: any[], logId: string, setLogId: Function, lines: number, setLines: Function, logState: any, refreshLogs: Function, logRef: any }} props
     */
    function LogsView(props) {
      const { t, apps, logId, setLogId, lines, setLines, logState, refreshLogs, logRef } = props;
      if (apps.length === 0) {
        return h(EmptyState, { title: t('servicesEmpty') });
      }
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dy-logs-toolbar' },
          h(
            'div',
            { className: 'dy-field' },
            h('label', { className: 'dy-label', htmlFor: 'dy-log-app' }, t('logsApp')),
            h(
              'select',
              {
                id: 'dy-log-app',
                className: 'dy-select',
                value: logId,
                onChange: (event) => setLogId(event.target.value),
              },
              ...apps.map((app) =>
                h(
                  'option',
                  { key: app.id, value: app.id },
                  `${app.projectName ? `${app.projectName} / ` : ''}${app.name}`,
                ),
              ),
            ),
          ),
        ),
        h(LogPanel, {
          t,
          idPrefix: 'dy-log',
          lines,
          setLines,
          logState,
          refreshLogs,
          logRef,
        }),
      );
    }

    /**
     * 就地查看日志的弹窗：从服务列表点「日志」直接开，不切走 tab。
     * Esc 与点击遮罩都能关闭；日志轮询仍由页面统一驱动。
     * @param {{ t: Function, app: any, lines: number, setLines: Function, logState: any, refreshLogs: Function, logRef: any, onClose: Function }} props
     */
    function LogModal(props) {
      const { t, app, lines, setLines, logState, refreshLogs, logRef, onClose } = props;
      const title = format(t('logModalLabel'), { name: app?.name ?? '' });
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [onClose]);
      return h(
        'div',
        {
          className: 'dy-modal-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'dy-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h(
            'div',
            { className: 'dy-modal-head' },
            h(
              'div',
              { className: 'dy-modal-title-block' },
              h('span', { className: 'dy-modal-title' }, title),
              app && app.dir ? h('span', { className: 'dy-mono dy-modal-sub' }, app.dir) : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dy-btn',
                onClick: onClose,
                'aria-label': t('logModalClose'),
              },
              t('dismiss'),
            ),
          ),
          h(LogPanel, {
            t,
            idPrefix: 'dy-log-modal',
            lines,
            setLines,
            logState,
            refreshLogs,
            logRef,
          }),
        ),
      );
    }

    /**
     * 全局页。整页由四个内部 tab 组成：概览、服务、发现、日志。
     * @param {{ t?: (key: string) => string }} props
     */
    function DockyardPage(props) {
      const t = props.t ?? fallbackT;
      /** 由 apply 注入：桌面端走 preload，Web 端走 uiWorkspace 的 Host 选择器。 */
      const pickDirectory = props.pickDirectory;
      const [tab, setTab] = React.useState('overview');
      const [status, setStatus] = React.useState({
        phase: 'loading',
        applications: [],
        projects: [],
        system: null,
        preferences: { statusBar: readStatusBarCache() },
        sync: null,
        syncIntervalMs: 0,
        autoTakeover: false,
        lastAutoTakeover: null,
        warnings: [],
        scanRoots: [],
        error: '',
      });
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [confirmRemove, setConfirmRemove] = React.useState('');
      const [confirmRemoveProject, setConfirmRemoveProject] = React.useState('');
      const [manualRoots, setManualRoots] = React.useState('');
      const [pickerUnavailable, setPickerUnavailable] = React.useState(false);
      const [scanning, setScanning] = React.useState(false);
      const [picking, setPicking] = React.useState(false);
      const [scan, setScan] = React.useState(null);
      const [external, setExternal] = React.useState({ processes: [], error: '' });
      const lastServicesRoots = React.useRef('');
      const [selectedProjects, setSelectedProjects] = React.useState(
        () => /** @type {Set<string>} */ (new Set()),
      );
      const [confirmHostAll, setConfirmHostAll] = React.useState(false);
      const [logId, setLogId] = React.useState('');
      /** 日志弹窗里正在看的应用；空串表示弹窗关闭。 */
      const [logModalId, setLogModalId] = React.useState('');
      /** 服务页筛选状态放在页面层，切走 tab 再回来不会丢。 */
      const [query, setQuery] = React.useState('');
      const [statusFilter, setStatusFilter] = React.useState('all');
      const [languageFilter, setLanguageFilter] = React.useState('all');
      const [lines, setLines] = React.useState(200);
      const [logNonce, setLogNonce] = React.useState(0);
      const [logState, setLogState] = React.useState({
        phase: 'idle',
        lines: [],
        source: 'none',
        error: '',
      });
      const logRef = React.useRef(null);

      const loadStatus = React.useCallback(async (signal) => {
        try {
          const data = await fetchStatus(signal);
          writeStatusBarCache(data.preferences.statusBar);
          setStatus({ phase: 'ready', ...data, error: '' });
        } catch (error) {
          if (signal && signal.aborted) return;
          setStatus((previous) => ({ ...previous, phase: 'error', error: messageOf(error) }));
        }
      }, []);

      React.useEffect(() => {
        const controller = new AbortController();
        let timer = null;
        const tick = async () => {
          await loadStatus(controller.signal);
          if (!controller.signal.aborted) timer = setTimeout(tick, POLL_INTERVAL_MS);
        };
        void tick();
        return () => {
          controller.abort();
          if (timer !== null) clearTimeout(timer);
        };
      }, [loadStatus]);

      // 选中的日志服务要始终存在：列表变化时回退到第一个。
      React.useEffect(() => {
        if (status.phase !== 'ready') return;
        if (status.applications.length === 0) {
          if (logId !== '') setLogId('');
          return;
        }
        if (!status.applications.some((app) => app.id === logId)) {
          setLogId(status.applications[0].id);
        }
      }, [status.phase, status.applications, logId]);

      // 弹窗里的应用被移除或从托管列表消失时，弹窗自动关闭，不留悬空日志。
      React.useEffect(() => {
        if (logModalId === '') return;
        if (status.applications.some((app) => app.id === logModalId)) return;
        setLogModalId('');
      }, [status.applications, logModalId]);

      React.useEffect(() => {
        if ((tab !== 'logs' && logModalId === '') || logId === '') return undefined;
        const controller = new AbortController();
        let timer = null;
        const tick = async () => {
          try {
            const data = await fetchLogs(logId, lines, controller.signal);
            setLogState({ phase: 'ready', lines: data.lines, source: data.source, error: '' });
          } catch (error) {
            if (!controller.signal.aborted) {
              setLogState((previous) => ({
                ...previous,
                phase: 'error',
                error: messageOf(error),
              }));
            }
          } finally {
            if (!controller.signal.aborted) timer = setTimeout(tick, LOG_POLL_INTERVAL_MS);
          }
        };
        void tick();
        return () => {
          controller.abort();
          if (timer !== null) clearTimeout(timer);
        };
      }, [tab, logModalId, logId, lines, logNonce]);

      // 日志自动跟到底部，但只在用户本来就在底部时，避免打断向上翻阅。
      React.useEffect(() => {
        const node = logRef.current;
        if (!node) return;
        const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
        if (distance < 48) node.scrollTop = node.scrollHeight;
      }, [logState.lines]);

      const act = React.useCallback(
        async (action, payload, busyKey) => {
          setBusy(busyKey);
          setNotice(null);
          try {
            const result = await postAction(action, payload);
            await loadStatus();
            if (result && typeof result.reason === 'string' && result.reason !== '') {
              setNotice({ kind: 'info', text: result.reason });
            }
            return result;
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
            return null;
          } finally {
            setBusy('');
          }
        },
        [loadStatus],
      );

      /** 状态条开关：写 Host、更新本地快照，并让输入框上方的 dock 立刻重新拉取。 */
      const toggleStatusBar = React.useCallback(
        async (visible) => {
          setBusy('status-bar');
          setNotice(null);
          try {
            const result = await postAction('set-status-bar', { visible });
            const next = result?.visible !== false;
            writeStatusBarCache(next);
            setStatus((previous) => ({
              ...previous,
              preferences: { ...(previous.preferences ?? {}), statusBar: next },
            }));
            globalThis.dispatchEvent?.(new Event(DOCK_REFRESH_EVENT));
            setNotice({
              kind: 'info',
              text: next ? t('dockStatusBarOn') : t('dockStatusBarOff'),
            });
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          } finally {
            setBusy('');
          }
        },
        [t],
      );

      const removeApp = React.useCallback(
        async (id) => {
          const result = await act('remove', { id }, `remove:${id}`);
          if (result && result.removed) setConfirmRemove('');
        },
        [act],
      );

      const loadExternal = React.useCallback(async (roots) => {
        const uniqueRoots = [...new Set(roots.filter((root) => typeof root === 'string' && root))];
        if (uniqueRoots.length === 0) {
          setExternal({ processes: [], error: '' });
          return;
        }
        try {
          const result = await postAction('external', { roots: uniqueRoots });
          setExternal({
            processes: Array.isArray(result?.processes) ? result.processes : [],
            error: typeof result?.error === 'string' ? result.error : '',
          });
        } catch (error) {
          setExternal({ processes: [], error: messageOf(error) });
        }
      }, []);

      const scanFromRoots = React.useCallback(
        async (roots) => {
          setScanning(true);
          setNotice(null);
          try {
            const result = await postAction('scan', { roots });
            setScan({ ...result, roots });
            void loadExternal((result.projects ?? []).map((project) => project.root));
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          } finally {
            setScanning(false);
          }
        },
        [loadExternal],
      );

      const onSyncNow = React.useCallback(async () => {
        setBusy('sync');
        setNotice(null);
        try {
          const result = await postAction('sync', {});
          await loadStatus();
          setNotice({
            kind: 'info',
            text:
              `同步完成：新增 ${result.added}，变化 ${result.changed}，` +
              `失联 ${result.missing}，恢复 ${result.reappeared}，错误 ${result.errors}。`,
          });
        } catch (error) {
          setNotice({ kind: 'error', text: messageOf(error) });
        } finally {
          setBusy('');
        }
      }, [loadStatus]);

      const removeProject = React.useCallback(
        async (projectId) => {
          setBusy(`remove-project:${projectId}`);
          setNotice(null);
          try {
            const result = await postAction('remove-project', { projectId });
            await loadStatus();
            setConfirmRemoveProject('');
            if (typeof result?.reason === 'string' && result.reason !== '') {
              setNotice({ kind: result.removed ? 'info' : 'error', text: result.reason });
            }
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          } finally {
            setBusy('');
          }
        },
        [loadStatus],
      );

      /**
       * 项目级批量操作：按顺序逐个下发同一个动作。
       *
       * 刻意串行而不是 Promise.all：启动会抢端口、停止要等进程真的退出，
       * 同时打 20 个只会把失败原因搅在一起。单个应用失败不影响其余应用，
       * 最后汇总成一条提示，让人知道哪几个没成功。
       */
      const actProject = React.useCallback(
        async (action, targets, projectId) => {
          if (!Array.isArray(targets) || targets.length === 0) return null;
          setBusy(`${action}-project:${projectId}`);
          setNotice(null);
          let done = 0;
          const failures = [];
          try {
            for (const app of targets) {
              try {
                await postAction(action, { id: app.id });
                done += 1;
              } catch (error) {
                failures.push(`${app.name}：${messageOf(error)}`);
              }
            }
            await loadStatus();
            if (failures.length > 0) {
              setNotice({
                kind: 'error',
                text: format(t('batchFailed'), {
                  failed: failures.length,
                  detail: failures.slice(0, 3).join('；'),
                }),
              });
            } else {
              setNotice({ kind: 'info', text: format(t('batchDone'), { done }) });
            }
          } finally {
            setBusy('');
          }
          return null;
        },
        [loadStatus, t],
      );

      const onScan = React.useCallback(async () => {
        if (typeof pickDirectory !== 'function') {
          setNotice({ kind: 'error', text: t('discoverPickUnsupported') });
          setPickerUnavailable(true);
          return;
        }
        setPicking(true);
        setNotice(null);
        try {
          const path = await pickDirectory();
          // null = 用户取消；undefined = 当前环境没有可用选择器。
          if (path === null || path === undefined) {
            if (path === undefined) {
              setPickerUnavailable(true);
              setNotice({ kind: 'error', text: t('discoverPickUnsupported') });
            }
            return;
          }
          await scanFromRoots([path]);
        } catch (error) {
          setNotice({
            kind: 'error',
            text: `${t('discoverPickFailed')}：${messageOf(error)}`,
          });
        } finally {
          setPicking(false);
        }
      }, [pickDirectory, t, scanFromRoots]);

      const onFallbackScan = React.useCallback(async () => {
        const roots = manualRoots
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '');
        if (roots.length === 0) {
          setNotice({ kind: 'error', text: t('discoverRootsRequired') });
          return;
        }
        await scanFromRoots(roots);
      }, [manualRoots, t, scanFromRoots]);

      const onTakeoverProject = React.useCallback(
        async (project) => {
          if (!scan) return;
          setBusy(`takeover:${project.id}`);
          setNotice(null);
          try {
            const result = await postAction('takeover-project', {
              projectId: project.id,
              roots: scan.roots,
            });
            await loadStatus();
            await loadExternal((scan.projects ?? []).map((item) => item.root));
            if (result?.takenOver) {
              setScan((previous) => {
                if (!previous) return previous;
                return {
                  ...previous,
                  projects: (previous.projects ?? []).map((item) =>
                    item.id === project.id
                      ? {
                          ...item,
                          ecosystems: (item.ecosystems ?? []).map((group) => ({
                            ...group,
                            apps: (group.apps ?? []).map((app) => ({
                              ...app,
                              alreadyAdded: true,
                            })),
                          })),
                        }
                      : item,
                  ),
                };
              });
            }
            if (typeof result?.reason === 'string' && result.reason !== '') {
              setNotice({ kind: result.takenOver ? 'info' : 'error', text: result.reason });
            }
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          } finally {
            setBusy('');
          }
        },
        [scan, loadStatus, loadExternal],
      );

      const onTakeoverHostedProject = React.useCallback(
        async (project) => {
          setBusy(`takeover:${project.id}`);
          setNotice(null);
          try {
            const result = await postAction('takeover-project', {
              projectId: project.id,
              roots: [project.root],
            });
            await loadStatus();
            await loadExternal((status.projects ?? []).map((item) => item.root));
            if (typeof result?.reason === 'string' && result.reason !== '') {
              setNotice({ kind: result.takenOver ? 'info' : 'error', text: result.reason });
            }
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          } finally {
            setBusy('');
          }
        },
        [status.projects, loadStatus, loadExternal],
      );

      React.useEffect(() => {
        if (tab !== 'services') return;
        const roots = (status.projects ?? [])
          .map((project) => project.root)
          .filter((root) => typeof root === 'string' && root !== '');
        const key = roots.join('|');
        if (key === '' || key === lastServicesRoots.current) return;
        lastServicesRoots.current = key;
        void loadExternal(roots);
      }, [tab, status.projects, loadExternal]);

      const onToggleSelected = React.useCallback((projectId, checked) => {
        setSelectedProjects((previous) => {
          const next = new Set(previous);
          if (checked) next.add(projectId);
          else next.delete(projectId);
          return next;
        });
      }, []);

      const onToggleAll = React.useCallback(
        (checked) => {
          const ids = (scan?.projects ?? [])
            .filter((project) => (project.ecosystems ?? []).length > 0)
            .map((project) => project.id);
          setSelectedProjects(new Set(checked ? ids : []));
        },
        [scan],
      );

      const hostProjects = React.useCallback(
        async (projectIds) => {
          if (!scan || projectIds.length === 0) return;
          setBusy('host');
          setNotice(null);
          setConfirmHostAll(false);
          try {
            const result = await postAction('add-projects', {
              projectIds,
              roots: scan.roots,
            });
            await loadStatus();
            const hosted = new Set(Array.isArray(result?.projectIds) ? result.projectIds : []);
            if (hosted.size > 0) {
              setScan((previous) => {
                if (!previous) return previous;
                return {
                  ...previous,
                  projects: (previous.projects ?? []).map((project) =>
                    hosted.has(project.id)
                      ? {
                          ...project,
                          ecosystems: (project.ecosystems ?? []).map((group) => ({
                            ...group,
                            apps: (group.apps ?? []).map((app) => ({
                              ...app,
                              alreadyAdded: true,
                            })),
                          })),
                        }
                      : project,
                  ),
                };
              });
              setSelectedProjects(new Set());
            }
            if (typeof result?.reason === 'string' && result.reason !== '') {
              setNotice({ kind: 'info', text: result.reason });
            }
            if (Array.isArray(result?.missing) && result.missing.length > 0) {
              setNotice({
                kind: 'error',
                text: `${result.missing.length} 个项目的磁盘状态已变化，请重新扫描。`,
              });
            }
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          } finally {
            setBusy('');
          }
        },
        [scan, loadStatus],
      );

      const onHostProject = React.useCallback(
        (project) => {
          void hostProjects([project.id]);
        },
        [hostProjects],
      );

      const onHostSelected = React.useCallback(() => {
        void hostProjects([...selectedProjects]);
      }, [hostProjects, selectedProjects]);

      const onRequestHostAll = React.useCallback(() => {
        setConfirmHostAll(true);
      }, []);

      const onConfirmHostAll = React.useCallback(() => {
        const ids = (scan?.projects ?? [])
          .filter((project) => (project.ecosystems ?? []).length > 0)
          .map((project) => project.id);
        void hostProjects(ids);
      }, [scan, hostProjects]);

      const onCancelHostAll = React.useCallback(() => {
        setConfirmHostAll(false);
      }, []);

      /** 概览里的「日志」仍然跳到整页日志 tab。 */
      const openLogs = React.useCallback((id) => {
        setLogId(id);
        setLogModalId('');
        setTab('logs');
      }, []);

      /** 服务列表里的「日志」就地开弹窗，不切走 tab。 */
      const openLogModal = React.useCallback((id) => {
        setLogId(id);
        setLogModalId(id);
      }, []);

      const closeLogModal = React.useCallback(() => {
        setLogModalId('');
      }, []);

      /** 切 tab 时关掉弹窗，避免弹窗盖在别的页面上。 */
      const selectTab = React.useCallback((next) => {
        setLogModalId('');
        setTab(next);
      }, []);

      /** 弹窗标题要用到应用名与目录；找不到就退化成空对象，不让弹窗炸掉。 */
      const logModalApp =
        logModalId === ''
          ? null
          : (status.applications.find((app) => app.id === logModalId) ?? null);

      const tabs = [
        ['overview', 'tabOverview'],
        ['services', 'tabServices'],
        ['discover', 'tabDiscover'],
        ['logs', 'tabLogs'],
      ];

      let content;
      if (tab === 'services') {
        content = h(ServicesView, {
          status,
          t,
          busy,
          onRemove: removeApp,
          confirmRemove,
          setConfirmRemove,
          confirmRemoveProject,
          setConfirmRemoveProject,
          onRemoveProject: removeProject,
          onProjectAction: actProject,
          sync: status.sync,
          syncIntervalMs: status.syncIntervalMs,
          autoTakeover: status.autoTakeover,
          lastAutoTakeover: status.lastAutoTakeover,
          onSync: onSyncNow,
          external,
          onTakeoverHosted: onTakeoverHostedProject,
          onLogs: openLogModal,
          onDiscover: () => setTab('discover'),
          query,
          setQuery,
          statusFilter,
          setStatusFilter,
          languageFilter,
          setLanguageFilter,
        });
      } else if (tab === 'discover') {
        content = h(DiscoverView, {
          t,
          canPick: !pickerUnavailable,
          manualRoots,
          setManualRoots,
          onScan,
          onFallbackScan,
          scanning,
          picking,
          scan,
          busy,
          selectedProjects,
          onToggleSelected,
          onToggleAll,
          onHostProject,
          onHostSelected,
          onRequestHostAll,
          confirmHostAll,
          onConfirmHostAll,
          onCancelHostAll,
          external,
          onTakeoverProject,
        });
      } else if (tab === 'logs') {
        content = h(LogsView, {
          t,
          apps: status.applications,
          logId,
          setLogId,
          lines,
          setLines,
          logState,
          refreshLogs: () => setLogNonce((value) => value + 1),
          logRef,
        });
      } else {
        content = h(OverviewView, {
          status,
          t,
          busy,
          onDiscover: () => setTab('discover'),
          onLogs: openLogs,
          onStart: (id) => act('start', { id }, `start:${id}`),
          confirmRemove,
          onRemove: removeApp,
          onCancelRemove: () => setConfirmRemove(''),
        });
      }

      const statusBarVisible = status.preferences?.statusBar !== false;

      return h(
        'div',
        { className: 'dy-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dy-inner' },
          h(
            'header',
            { className: 'dy-header' },
            h(
              'div',
              null,
              h('h1', { className: 'dy-title' }, t('pageTitle')),
              h('p', { className: 'dy-subtitle' }, t('pageSubtitle')),
            ),
            h(
              'div',
              { className: 'dy-header-actions' },
              busy !== '' ? h('span', { className: 'dy-busy' }, t('busy')) : null,
              h(
                'label',
                { className: 'dy-switch', title: t('dockStatusBarHint') },
                h('input', {
                  type: 'checkbox',
                  className: 'dy-switch-input',
                  checked: statusBarVisible,
                  disabled: busy !== '',
                  onChange: (event) => void toggleStatusBar(event.target.checked),
                }),
                h(
                  'span',
                  { className: 'dy-switch-track', 'aria-hidden': true },
                  h('span', { className: 'dy-switch-thumb' }),
                ),
                h('span', { className: 'dy-switch-label' }, t('dockStatusBar')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dy-btn',
                  onClick: () => void loadStatus(),
                },
                t('refresh'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dy-tabs', role: 'tablist', 'aria-label': t('pageTitle') },
            ...tabs.map(([id, key]) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  role: 'tab',
                  id: `dy-tab-${id}`,
                  className: 'dy-tab',
                  'aria-selected': tab === id,
                  'aria-controls': `dy-panel-${id}`,
                  onClick: () => selectTab(id),
                },
                t(key),
              ),
            ),
          ),
          status.phase === 'error' && status.applications.length > 0
            ? h(
                'div',
                { className: 'dy-notice dy-notice-error', role: 'alert' },
                h('span', { className: 'dy-notice-text' }, `${t('unavailable')}：${status.error}`),
              )
            : null,
          notice
            ? h(
                'div',
                {
                  className: `dy-notice dy-notice-${notice.kind}`,
                  role: notice.kind === 'error' ? 'alert' : 'status',
                },
                h('span', { className: 'dy-notice-text' }, notice.text),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dy-notice-close',
                    'aria-label': t('dismiss'),
                    onClick: () => setNotice(null),
                  },
                  '×',
                ),
              )
            : null,
          h(
            'div',
            {
              className: 'dy-panel',
              role: 'tabpanel',
              id: `dy-panel-${tab}`,
              'aria-labelledby': `dy-tab-${tab}`,
            },
            content,
          ),
        ),
        logModalApp
          ? h(LogModal, {
              t,
              app: logModalApp,
              lines,
              setLines,
              logState,
              refreshLogs: () => setLogNonce((value) => value + 1),
              logRef,
              onClose: closeLogModal,
            })
          : null,
      );
    }

    /**
     * 把应用归纳成"语言 + 包管理器"生态分组，按应用数降序。
     * 没有语言信息时退回生态名，再退回"未知语言"——不伪造分类。
     *
     * @param {any[]} applications
     * @param {(key: string) => string} t
     * @returns {{ key: string, language: string, manager: string, count: number }[]}
     */
    function ecosystemGroups(applications, t) {
      /** @type {Map<string, { key: string, language: string, manager: string, count: number }>} */
      const groups = new Map();
      for (const app of applications) {
        const language =
          typeof app.language === 'string' && app.language !== ''
            ? app.language
            : typeof app.ecosystemName === 'string' && app.ecosystemName !== ''
              ? app.ecosystemName
              : t('languageUnknown');
        const manager = typeof app.manager === 'string' ? app.manager : '';
        const key = `${language}::${manager}`;
        const group = groups.get(key);
        if (group) group.count += 1;
        else groups.set(key, { key, language, manager, count: 1 });
      }
      return [...groups.values()].sort(
        (a, b) => b.count - a.count || a.language.localeCompare(b.language),
      );
    }

    /**
     * 输入框上方的状态停靠条。
     *
     * 一个 compact bar，按"身份 → 健康 → 规模 → 资源 → 生态 → 操作"分块，
     * 状态用标签和语义色表达，其余信息保持中性，避免整条 bar 变成调色盘。
     * 宽度与输入框卡片对齐（见 CSS 里的 side-clearance / card-max-width 计算）。
     * 可以在服务坞页头关闭；开关持久化在 Host 侧，所有会话共享同一选择。
     *
     * @param {{ t?: (key: string) => string, openPanel?: () => void }} props
     */
    function DockyardDock(props) {
      const t = props.t ?? fallbackT;
      const [state, setState] = React.useState({
        phase: 'loading',
        applications: [],
        projects: [],
        system: null,
        preferences: { statusBar: readStatusBarCache() },
        warnings: [],
        error: '',
      });
      const [expanded, setExpanded] = React.useState(false);
      const [refreshNonce, setRefreshNonce] = React.useState(0);

      React.useEffect(() => {
        const controller = new AbortController();
        let timer = null;
        let inFlight = false;
        const tick = async () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          if (inFlight) return;
          inFlight = true;
          try {
            const data = await fetchStatus(controller.signal);
            if (controller.signal.aborted) return;
            writeStatusBarCache(data.preferences.statusBar);
            setState({ phase: 'ready', ...data, error: '' });
          } catch (error) {
            if (controller.signal.aborted) return;
            setState((previous) => ({
              ...previous,
              phase: 'error',
              error: messageOf(error),
            }));
          } finally {
            inFlight = false;
            if (!controller.signal.aborted) timer = setTimeout(tick, POLL_INTERVAL_MS);
          }
        };
        const refresh = () => {
          void tick();
        };
        globalThis.addEventListener?.(DOCK_REFRESH_EVENT, refresh);
        void tick();
        return () => {
          globalThis.removeEventListener?.(DOCK_REFRESH_EVENT, refresh);
          controller.abort();
          if (timer !== null) clearTimeout(timer);
        };
      }, [refreshNonce]);

      // 用户在服务坞页头关掉状态条时，这里连 style 都不注入，输入框上方不留空隙。
      if (state.preferences.statusBar === false) return null;

      const apps = state.applications;
      const total = apps.length;
      const runningApps = apps.filter((app) => app.status === 'running');
      const crashedApps = apps.filter((app) => app.status === 'crashed');
      const missingApps = apps.filter((app) => app.missing === true);
      const runningCount = runningApps.length;
      const crashedCount = crashedApps.length;
      const missingCount = missingApps.length;
      // 没有采样时宁可显示"—"：运行中但平台不支持采样，和"CPU 真的是 0%"是两回事。
      const cpuSamples = runningApps.filter((app) => Number.isFinite(app.cpuPercent));
      const rssSamples = runningApps.filter((app) => Number.isFinite(app.rssBytes));
      const sumOf = (list, key) => list.reduce((sum, app) => sum + Number(app[key]), 0);
      const totalCpu =
        runningCount === 0
          ? 0
          : cpuSamples.length > 0
            ? sumOf(cpuSamples, 'cpuPercent')
            : undefined;
      const totalRss =
        runningCount === 0 ? 0 : rssSamples.length > 0 ? sumOf(rssSamples, 'rssBytes') : undefined;
      const projectCount = Array.isArray(state.projects)
        ? state.projects.length
        : new Set(apps.map((app) => app.projectId ?? app.projectRoot ?? app.id)).size;
      const ecosystems = ecosystemGroups(apps, t);
      const shownEcosystems = ecosystems.slice(0, 2);
      const hiddenEcosystems = ecosystems.length - shownEcosystems.length;
      const system = state.system ?? {};
      const hostTotal = Number(system.totalmem) || 0;
      const hostFree = Number(system.freemem) || 0;
      const hostUsed = hostTotal > 0 ? Math.max(0, hostTotal - hostFree) : 0;
      const errorPhase = state.phase === 'error';
      const tone =
        crashedCount > 0
          ? 'error'
          : missingCount > 0 || errorPhase
            ? 'warn'
            : runningCount > 0
              ? 'success'
              : 'idle';
      const cpuTone =
        totalCpu === undefined
          ? 'idle'
          : totalCpu >= 85
            ? 'error'
            : totalCpu >= 60
              ? 'warn'
              : 'success';
      const cpuWidth = totalCpu === undefined ? 0 : Math.max(0, Math.min(100, totalCpu));
      const memoryTitle =
        hostTotal > 0
          ? `${t('dockMemoryTitle')} · ${format(t('dockHostMemory'), {
              used: formatBytes(hostUsed),
              total: formatBytes(hostTotal),
            })}`
          : t('dockMemoryTitle');
      const ecoTitle = format(t('dockEcoTitle'), {
        detail:
          ecosystems
            .map(
              (group) =>
                `${group.language}${group.manager ? ` · ${group.manager}` : ''} ${group.count}`,
            )
            .join(' / ') || t('dockEmpty'),
      });

      /** @param {string} toneName @param {string} label @param {string} [title] */
      const chip = (toneName, label, title) =>
        h(
          'span',
          { className: 'dy-chip', 'data-tone': toneName, title },
          h('span', { className: 'dy-chip-dot', 'aria-hidden': true }),
          h('span', null, label),
        );

      /** @param {number} count @param {string} label */
      const metric = (count, label) =>
        h(
          'span',
          { className: 'dy-metric' },
          h('span', { className: 'dy-metric-value' }, String(count)),
          h('span', { className: 'dy-metric-label' }, label),
        );

      const brandChildren = [
        h('span', { className: 'dy-bar-mark' }, h(DockyardIcon, { size: 14 })),
        h('span', { className: 'dy-bar-title' }, t('pageTitle')),
      ];
      const brand = props.openPanel
        ? h(
            'button',
            {
              type: 'button',
              className: 'dy-bar-brand dy-bar-brand-btn',
              title: t('dockOpen'),
              onClick: props.openPanel,
            },
            ...brandChildren,
          )
        : h('span', { className: 'dy-bar-brand', title: t('dockAria') }, ...brandChildren);

      const openButton = props.openPanel
        ? h(
            'button',
            {
              type: 'button',
              className: 'dy-bar-icon',
              title: t('dockOpen'),
              'aria-label': t('dockOpen'),
              onClick: props.openPanel,
            },
            h(
              'svg',
              {
                width: 13,
                height: 13,
                viewBox: '0 0 16 16',
                fill: 'none',
                'aria-hidden': true,
              },
              h('path', {
                d: 'M6 3.5h6.5V10M12.5 3.5 5 11',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
          )
        : null;

      /** 空间足够的简单状态用带文字的打开按钮，图标按钮留给信息密集的主 bar。 */
      const openTextButton = props.openPanel
        ? h(
            'button',
            { type: 'button', className: 'dy-bar-btn', onClick: props.openPanel },
            t('dockOpen'),
          )
        : null;

      /** 首次加载 / 不可用但不占大块空间：仍然给出明确文案，不出现空白条。 */
      const simpleBar = (children, toneName) =>
        h(
          'div',
          { className: 'dy-dock-strip' },
          h('style', null, CSS),
          h(
            'div',
            {
              className: 'dy-bar',
              role: 'group',
              'aria-label': t('dockAria'),
              'data-tone': toneName,
            },
            ...children,
          ),
        );

      if (total === 0 && state.phase === 'loading') {
        return simpleBar(
          [
            brand,
            h('span', { className: 'dy-bar-sep' }),
            chip('neutral', t('dockLoading')),
            h('span', { className: 'dy-bar-spacer' }),
            openTextButton,
          ],
          'idle',
        );
      }

      if (total === 0 && errorPhase) {
        return simpleBar(
          [
            brand,
            h('span', { className: 'dy-bar-sep' }),
            chip('error', t('dockUnavailable')),
            h('span', { className: 'dy-bar-error', title: state.error }, state.error),
            h('span', { className: 'dy-bar-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dy-bar-btn',
                onClick: () => setRefreshNonce((value) => value + 1),
              },
              t('dockRetry'),
            ),
            openTextButton,
          ],
          'error',
        );
      }

      if (total === 0) {
        return simpleBar(
          [
            brand,
            h('span', { className: 'dy-bar-sep' }),
            h('span', { className: 'dy-bar-state' }, t('dockEmpty')),
            h('span', { className: 'dy-bar-spacer' }),
            openTextButton,
          ],
          'idle',
        );
      }

      const ranked = [...apps].sort((a, b) => {
        const rank = (app) =>
          app.status === 'crashed'
            ? 0
            : app.missing === true
              ? 1
              : app.status === 'unknown'
                ? 2
                : app.restartRequired === true
                  ? 3
                  : app.status === 'running'
                    ? 4
                    : 5;
        return rank(a) - rank(b);
      });
      // 明细只保留"需要关注"和"正在运行"的应用：90 多个已停止应用不该淹没真正的信息。
      const detailRows = ranked.filter(
        (app) =>
          app.status === 'crashed' ||
          app.status === 'unknown' ||
          app.status === 'running' ||
          app.missing === true ||
          app.restartRequired === true,
      );

      const detailRow = (app) => {
        const rowTone =
          app.status === 'crashed'
            ? 'error'
            : app.missing === true || app.status === 'unknown' || app.restartRequired === true
              ? 'warn'
              : 'success';
        const statusLabel =
          app.status === 'crashed'
            ? t('dockCrashed')
            : app.missing === true
              ? t('dockMissing')
              : app.status === 'unknown'
                ? t('statusUnknown')
                : app.status === 'running'
                  ? t('dockRunningSuffix')
                  : t('statusStopped');
        const meta = [];
        if (app.pid) meta.push(`pid ${app.pid}`);
        if (app.status === 'running' && Number.isFinite(app.cpuPercent)) {
          meta.push(`CPU ${formatPercent(app.cpuPercent, '—')}`);
        }
        if (app.status === 'running' && Number.isFinite(app.rssBytes) && app.rssBytes > 0) {
          meta.push(formatBytes(app.rssBytes));
        }
        if (Number.isFinite(app.uptimeMs) && app.uptimeMs > 0) {
          meta.push(formatUptime(app.uptimeMs, t));
        }
        return h(
          'div',
          { key: app.id, className: 'dy-dock-row', title: app.statusReason ?? '' },
          h('span', { className: 'dy-dock-dot', 'data-tone': rowTone, 'aria-hidden': true }),
          h('span', { className: 'dy-dock-row-name' }, app.name),
          app.projectName ? h('span', { className: 'dy-dock-row-project' }, app.projectName) : null,
          h(
            'span',
            { className: 'dy-dock-row-status', 'data-tone': rowTone },
            app.restartRequired === true
              ? `${statusLabel} · ${t('dockRestartRequired')}`
              : statusLabel,
          ),
          meta.length > 0 ? h('span', { className: 'dy-dock-row-meta' }, meta.join(' · ')) : null,
        );
      };

      const ecoTags = shownEcosystems.map((group) =>
        h(
          'span',
          {
            key: group.key,
            className: 'dy-tag-eco',
            title: `${group.language}${group.manager ? ` · ${group.manager}` : ''} · ${group.count}`,
          },
          h('b', null, group.language),
          group.manager ? h('em', null, `· ${group.manager}`) : null,
          h('span', { className: 'dy-tag-eco-count' }, String(group.count)),
        ),
      );
      if (hiddenEcosystems > 0) {
        ecoTags.push(
          h(
            'span',
            { key: 'dock-eco-more', className: 'dy-tag-eco dy-tag-eco-more', title: ecoTitle },
            `+${hiddenEcosystems}`,
          ),
        );
      }

      const runningRows = detailRows.filter((app) => app.status === 'running');
      const attentionRows = detailRows.filter((app) => app.status !== 'running');

      const detailPanel = expanded
        ? h(
            'div',
            { className: 'dy-dock-panel', id: 'dy-dock-detail' },
            h(
              'div',
              { className: 'dy-dock-panel-head' },
              h('span', null, `${t('dockAttention')} ${attentionRows.length}`),
              h('span', null, `${t('dockRunningSection')} ${runningRows.length}`),
            ),
            detailRows.length > 0
              ? h(React.Fragment, null, ...detailRows.map(detailRow))
              : h('div', { className: 'dy-dock-panel-empty' }, t('dockAttentionEmpty')),
            state.warnings.length > 0
              ? h('div', { className: 'dy-dock-warn' }, state.warnings.join(' / '))
              : null,
            props.openPanel
              ? h(
                  'div',
                  { className: 'dy-dock-panel-foot' },
                  h(
                    'button',
                    { type: 'button', className: 'dy-bar-btn', onClick: props.openPanel },
                    format(t('dockAllApps'), { count: total }),
                  ),
                )
              : null,
          )
        : null;

      return h(
        'div',
        { className: 'dy-dock-strip' },
        h('style', null, CSS),
        h(
          'div',
          {
            className: 'dy-bar',
            role: 'group',
            'aria-label': t('dockAria'),
            'data-tone': tone,
          },
          brand,
          h('span', { className: 'dy-bar-sep' }),
          h(
            'span',
            { className: 'dy-bar-chunk dy-bar-health' },
            chip(
              'success',
              `${runningCount}/${total} ${t('dockRunningSuffix')}`,
              t('dockRunningSuffix'),
            ),
            crashedCount > 0
              ? chip(
                  'error',
                  `${crashedCount} ${t('dockCrashed')}`,
                  crashedApps
                    .map((app) => `${app.projectName ? `${app.projectName} / ` : ''}${app.name}`)
                    .join('、'),
                )
              : null,
            missingCount > 0
              ? chip(
                  'warn',
                  `${missingCount} ${t('dockMissing')}`,
                  missingApps
                    .map((app) => `${app.projectName ? `${app.projectName} / ` : ''}${app.name}`)
                    .join('、'),
                )
              : null,
            errorPhase ? chip('error', t('dockUnavailable'), state.error) : null,
          ),
          h('span', { className: 'dy-bar-sep' }),
          h(
            'span',
            { className: 'dy-bar-chunk dy-bar-scale' },
            metric(projectCount, t('dockProjects')),
          ),
          h('span', { className: 'dy-bar-sep' }),
          h(
            'span',
            { className: 'dy-bar-chunk dy-bar-res' },
            h(
              'span',
              { className: 'dy-res', 'data-tone': cpuTone, title: t('dockCpuTitle') },
              h('span', { className: 'dy-res-label' }, t('dockCpu')),
              h(
                'span',
                { className: 'dy-res-meter', 'aria-hidden': true },
                h('i', { className: 'dy-res-fill', style: { width: `${cpuWidth}%` } }),
              ),
              h('span', { className: 'dy-res-value' }, formatPercent(totalCpu, '—')),
            ),
            h(
              'span',
              { className: 'dy-res', title: memoryTitle },
              h('span', { className: 'dy-res-label' }, t('dockMemory')),
              h(
                'span',
                { className: 'dy-res-value' },
                Number.isFinite(totalRss) ? formatBytes(totalRss) : '—',
              ),
            ),
          ),
          h('span', { className: 'dy-bar-sep' }),
          h(
            'span',
            { className: 'dy-bar-chunk dy-bar-eco', title: ecoTitle },
            h('span', { className: 'dy-eco-label' }, t('dockEcosystems')),
            ...ecoTags,
          ),
          h('span', { className: 'dy-bar-spacer' }),
          h(
            'span',
            { className: 'dy-bar-actions' },
            openButton,
            h(
              'button',
              {
                type: 'button',
                className: 'dy-bar-icon',
                'aria-expanded': expanded,
                'aria-controls': 'dy-dock-detail',
                'aria-label': t('dockDetails'),
                title: t('dockDetails'),
                onClick: () => setExpanded((value) => !value),
              },
              h('span', { className: 'dy-chevron', 'aria-hidden': true }),
            ),
          ),
        ),
        detailPanel,
      );
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES));
        const translate = ctx.locale.bind(NS);

        /** 打开整页。页与入口共用同一个 id。 */
        const openPanel = () => {
          try {
            ctx.layout.selectPanel(PANEL_ID);
          } catch (error) {
            ctx.logger?.warn?.(
              `[dockyard] 无法打开面板：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };

        /**
         * 打开系统文件夹选择器。
         *
         * - 桌面端：preload 暴露的窄接口（见 DIRECTORY_PICKER_BRIDGE），
         *   直接调用 Electron 主进程的 `dialog.showOpenDialog`；页面在
         *   `dsh-app://app` 上，IPC 校验能通过。
         * - Web 端：退回 `uiWorkspace.pickDirectory()`，由 Host 侧打开原生选择器。
         *
         * @returns {Promise<string | null | undefined>} 绝对路径；取消为 null；
         *   当前环境没有选择器时为 undefined。
         */
        const pickDirectory = async () => {
          const bridge = globalThis[DIRECTORY_PICKER_BRIDGE];
          if (bridge && typeof bridge.pick === 'function') return bridge.pick();
          const workspace =
            typeof ctx.get === 'function' ? ctx.get('uiWorkspace', false) : undefined;
          if (workspace && typeof workspace.pickDirectory === 'function') {
            return workspace.pickDirectory();
          }
          return undefined;
        };

        /**
         * 单个槽位注册失败只应记一条警告，而不是让整个插件激活失败——
         * 激活失败会连带 Host 半侧一起不生效。
         * @param {string} label
         * @param {() => void} register
         */
        const safely = (label, register) => {
          try {
            register();
          } catch (error) {
            ctx.logger?.warn?.(`[dockyard] 无法注册${label}：${messageOf(error)}`);
          }
        };

        safely('状态停靠条', () =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'dockyard-status',
                order: 40,
                locale: NS,
                inject: () => ({ openPanel }),
              },
              DockyardDock,
            ),
          ),
        );

        safely('左侧栏入口', () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 10,
                label: () => translate('panel'),
                locale: NS,
              },
              DockyardIcon,
            ),
          ),
        );

        safely('服务坞页面', () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
                inject: () => ({ pickDirectory }),
              },
              DockyardPage,
            ),
          ),
        );
      },
    };
  },
});
