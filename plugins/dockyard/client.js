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
        lastSyncAt: '最后同步 {time}',
        tabOverview: '概览',
        tabServices: '服务',
        tabDiscover: '发现',
        tabLogs: '日志',
        tabOverviewMetrics: '概览·指标',
        tabOverviewHealth: '概览·健康',
        ovSectionOverview: '运行概况',
        ovSectionOverviewHint: '服务生命周期、规模与资源的一次性快照',
        ovMetricCount: '{count} 项指标',
        ovUpdatedAt: '更新于 {time} · 每 5 秒刷新',
        ovGroupStatus: '服务状态',
        ovGroupStatusMeta: '{apps} 个应用 · {projects} 个项目',
        ovGroupScale: '规模与构成',
        ovGroupScaleMeta: '按已托管应用统计',
        ovGroupResources: '资源与运行',
        ovGroupResourcesMeta: '近似采样，见脚注',
        ovLabelAttention: '需关注',
        ovLabelApps: '应用',
        ovLabelLanguages: '语言',
        ovLabelManagers: '包管理器',
        ovLabelAvgUptime: '平均运行时长',
        ovLabelLongest: '最长运行',
        ovAttentionHint: '异常 {crashed} · 失联 {missing} · 需重启 {restart}',
        ovCrashedHint: '优先排查',
        ovStoppedHint: '{count} 个应用可随时启动',
        ovStatProjectsHint: '{apps} 个应用 · 平均 {avg} 个/项目',
        ovStatAppsHint: '{running} 运行中 · {idle} 未运行',
        ovStatLanguagesHint: '{name} {count} 个应用最多',
        ovStatManagersHint: '{name} {count} 个应用最多',
        ovStatCpuHint: '峰值 {peak} · {running} 个运行中',
        ovStatMemoryHint: '占宿主 {percent} · 峰值 {peak}',
        ovStatAvgUptimeHint: '{running} 个运行中应用',
        ovStatLongestHint: '{name} 持续在线',
        ovSectionDistribution: '构成与分布',
        ovSectionDistributionHint: '状态、语言、包管理器与技术栈，口径一致',
        ovSectionDistributionMeta: '共 {count} 个应用',
        ovStatusTitle: '状态构成',
        ovStatusSubtitle: '按应用真实状态统计',
        ovStatusMeta: '{count} 个应用',
        ovStatusOverlay: '叠加状态：',
        ovStatusMissing: '失联 {count}',
        ovStatusRestart: '需重启 {count}',
        ovStatusRunRate: '应用运行率',
        ovLanguageTitle: '语言分布',
        ovLanguageSubtitle: '按已托管应用的语言分组',
        ovLanguageFootnote: '实心段 = 运行中；半透明段 = 未运行。',
        ovManagerTitle: '包管理器分布',
        ovManagerSubtitle: '按应用实际使用的启动管理器',
        ovManagerFootnote: '“未声明”是识别不到管理器的 Shell 等入口，不代表操作系统包管理器。',
        ovManagerUndeclared: '未声明',
        ovDistKinds: '{count} 种',
        ovDistSub: '{running} 运行 · {projects} 项目',
        ovDistTitle: '{name}：{count} 个应用，{running} 个运行中',
        ovTechTitle: '技术栈分布',
        ovTechSubtitle: '语言 × 包管理器的组合',
        ovTechKinds: '{count} 种',
        ovTechFoot: '{name} 占比 {percent}，覆盖 {projects} 个项目。',
        ovTechEmpty: '暂无技术栈数据。',
        ovTechAria: '技术栈分布：{detail}',
        ovResourceTitle: '资源趋势',
        ovResourceSubtitle: '最近 5 分钟 · {count} 次采样',
        ovResourceInterval: '5s / 次',
        ovResourceCpu: 'CPU',
        ovResourceMemory: '内存',
        ovResourcePeak: '峰值 {value}',
        ovResourceFootnote: '进程组采样：CPU 可超过 100%，RSS 为进程组求和的上界。',
        ovResourceEmpty: '暂无采样',
        ovHostTitle: '宿主系统',
        ovHostSubtitle: '本机运行环境',
        ovHostMemory: '内存占用',
        ovHostMemoryValue: '{used} / {total} GB',
        ovHostLoad: '负载 1 / 5 / 15',
        ovHostCores: '核心',
        ovHostUptime: '运行时长',
        ovHostPlatform: '平台',
        ovHostFootnote: '内存占用含缓存；负载为 1 / 5 / 15 分钟均值。',
        ovSectionLoad: '负载与排行',
        ovSectionLoadHint: '项目行标出语言与包管理器，与上方分布对齐',
        ovLoadMeta: 'CPU 合计 {cpu} · RSS {memory}',
        ovProjectLoadTitle: '项目负载',
        ovProjectLoadSubtitle: '按运行中应用数与 CPU 排序',
        ovProjectLoadMeta: '{projects} 个项目 · {apps} 应用',
        ovProjectApps: '{count} 应用',
        ovProjectRunning: '{count} 运行',
        ovRankCpuTitle: 'CPU 排行',
        ovRankMemoryTitle: '内存排行',
        ovRankSubtitle: '运行中应用 Top 5',
        ovRankCpu: 'CPU',
        ovRankRss: 'RSS',
        ovRankFootnote: 'CPU 为进程组采样，可超过 100%；RSS 为上界估计。',
        ovRankingTitle: '应用排行',
        ovAttentionTitle: '需要关注',
        ovAttentionSubtitle: '异常、失联与待重启优先处理',
        ovAttentionMeta: '按严重程度排序',
        ovAttentionFoot: '异常与失联优先处理；日志入口见服务页。',
        ovRunningHint: '按运行时长排序',
        ovRunningMeta: '每 5 秒刷新',
        ovActionSync: '同步',
        ovHealthKicker: '运行健康',
        ovHealthAppsRunning: '/ {total} 应用运行中',
        ovHealthRunRate: '运行率 {percent}',
        ovHealthCrashed: '异常 {count}',
        ovHealthMissing: '失联 {count}',
        ovHealthRestart: '需重启 {count}',
        ovHealthProjects: '项目',
        ovHealthLanguages: '语言',
        ovHealthManagers: '包管理器',
        ovHealthAvgUptime: '平均运行',
        ovHealthTechSection: '技术构成',
        ovHealthTechSectionHint: '语言、包管理器与组合栈',
        ovHealthTechMeta: '{count} 种技术栈',
        ovHealthResourcesSection: '资源与宿主',
        ovHealthResourcesHint: '最近 5 分钟趋势，以及本机运行环境',
        ovHealthResourcesMeta: '5s / 次',
        ovHealthProjectSection: '项目与排行',
        ovHealthProjectHint: '项目负载与应用 Top 5',
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
        managedBadge: '托管',
        unmanagedBadge: '非托管',
        externalRunning: '外部运行',
        externalPorts: '端口 {ports}',
        takeoverApp: '接管',
        externalRestartHint: '停止外部进程，再由 dockyard 重启（即接管）。',
        takeoverAll: '一键接管',
        takeoverAllCount: '一键接管（{count}）',
        filterUnmanaged: '非托管',
        externalAppsHint:
          '外部启动的应用只能读取状态、CPU/内存和端口；接管后由 dockyard 重启，才能采集日志。',
        externalUnmatchedCount: '未识别外部进程 {count}',
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
        dockStopped: '已停止',
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
        lastSyncAt: 'Last sync {time}',
        tabOverview: 'Overview',
        tabServices: 'Services',
        tabDiscover: 'Discover',
        tabLogs: 'Logs',
        tabOverviewMetrics: 'Overview · Metrics',
        tabOverviewHealth: 'Overview · Health',
        ovSectionOverview: 'At a glance',
        ovSectionOverviewHint: 'Lifecycle, scale and resources in one snapshot',
        ovMetricCount: '{count} metrics',
        ovUpdatedAt: 'Updated {time} · every 5s',
        ovGroupStatus: 'Service status',
        ovGroupStatusMeta: '{apps} apps · {projects} projects',
        ovGroupScale: 'Scale & mix',
        ovGroupScaleMeta: 'Across hosted apps',
        ovGroupResources: 'Resources & uptime',
        ovGroupResourcesMeta: 'Approximate samples, see footnote',
        ovLabelAttention: 'Attention',
        ovLabelApps: 'Apps',
        ovLabelLanguages: 'Languages',
        ovLabelManagers: 'Package managers',
        ovLabelAvgUptime: 'Avg uptime',
        ovLabelLongest: 'Longest uptime',
        ovAttentionHint: 'Crashed {crashed} · missing {missing} · restart {restart}',
        ovCrashedHint: 'Investigate first',
        ovStoppedHint: '{count} apps can start anytime',
        ovStatProjectsHint: '{apps} apps · {avg} per project',
        ovStatAppsHint: '{running} running · {idle} idle',
        ovStatLanguagesHint: '{name} leads with {count} apps',
        ovStatManagersHint: '{name} leads with {count} apps',
        ovStatCpuHint: 'Peak {peak} · {running} running',
        ovStatMemoryHint: '{percent} of host · peak {peak}',
        ovStatAvgUptimeHint: 'Across {running} running apps',
        ovStatLongestHint: '{name} still online',
        ovSectionDistribution: 'Composition & distribution',
        ovSectionDistributionHint: 'Status, language, package manager and stack share one scope',
        ovSectionDistributionMeta: '{count} apps total',
        ovStatusTitle: 'Status composition',
        ovStatusSubtitle: 'Based on real app status',
        ovStatusMeta: '{count} apps',
        ovStatusOverlay: 'Overlays:',
        ovStatusMissing: 'Missing {count}',
        ovStatusRestart: 'Restart {count}',
        ovStatusRunRate: 'App run rate',
        ovLanguageTitle: 'Language distribution',
        ovLanguageSubtitle: 'Grouped by hosted app language',
        ovLanguageFootnote: 'Solid = running; translucent = not running.',
        ovManagerTitle: 'Package manager distribution',
        ovManagerSubtitle: 'By the manager each app actually starts with',
        ovManagerFootnote:
          '“Undeclared” means no manager was detected (e.g. a Shell entry), not the OS package manager.',
        ovManagerUndeclared: 'Undeclared',
        ovDistKinds: '{count} kinds',
        ovDistSub: '{running} running · {projects} projects',
        ovDistTitle: '{name}: {count} apps, {running} running',
        ovTechTitle: 'Stack distribution',
        ovTechSubtitle: 'Language × package manager combinations',
        ovTechKinds: '{count} kinds',
        ovTechFoot: '{name} takes {percent}, covering {projects} projects.',
        ovTechEmpty: 'No stack data yet.',
        ovTechAria: 'Stack distribution: {detail}',
        ovResourceTitle: 'Resource trend',
        ovResourceSubtitle: 'Last 5 minutes · {count} samples',
        ovResourceInterval: 'every 5s',
        ovResourceCpu: 'CPU',
        ovResourceMemory: 'Memory',
        ovResourcePeak: 'Peak {value}',
        ovResourceFootnote: 'Process-group sampling: CPU can exceed 100%, RSS is an upper bound.',
        ovResourceEmpty: 'No samples yet',
        ovHostTitle: 'Host system',
        ovHostSubtitle: 'Local runtime',
        ovHostMemory: 'Memory used',
        ovHostMemoryValue: '{used} / {total} GB',
        ovHostLoad: 'Load 1 / 5 / 15',
        ovHostCores: 'Cores',
        ovHostUptime: 'Uptime',
        ovHostPlatform: 'Platform',
        ovHostFootnote: 'Memory used includes cache; load is the 1 / 5 / 15 minute average.',
        ovSectionLoad: 'Load & rankings',
        ovSectionLoadHint: 'Project rows carry language and package-manager tags',
        ovLoadMeta: 'CPU total {cpu} · RSS {memory}',
        ovProjectLoadTitle: 'Project load',
        ovProjectLoadSubtitle: 'Sorted by running apps and CPU',
        ovProjectLoadMeta: '{projects} projects · {apps} apps',
        ovProjectApps: '{count} apps',
        ovProjectRunning: '{count} running',
        ovRankCpuTitle: 'CPU ranking',
        ovRankMemoryTitle: 'Memory ranking',
        ovRankSubtitle: 'Top 5 running apps',
        ovRankCpu: 'CPU',
        ovRankRss: 'RSS',
        ovRankFootnote: 'CPU comes from process-group sampling; RSS is an upper bound.',
        ovRankingTitle: 'App ranking',
        ovAttentionTitle: 'Needs attention',
        ovAttentionSubtitle: 'Crashed, missing and restart-required first',
        ovAttentionMeta: 'Sorted by severity',
        ovAttentionFoot: 'Crashed and missing first; log entries live on the Services tab.',
        ovRunningHint: 'Sorted by uptime',
        ovRunningMeta: 'Refreshes every 5s',
        ovActionSync: 'Sync',
        ovHealthKicker: 'Runtime health',
        ovHealthAppsRunning: '/ {total} apps running',
        ovHealthRunRate: 'Run rate {percent}',
        ovHealthCrashed: 'Crashed {count}',
        ovHealthMissing: 'Missing {count}',
        ovHealthRestart: 'Restart {count}',
        ovHealthProjects: 'Projects',
        ovHealthLanguages: 'Languages',
        ovHealthManagers: 'Managers',
        ovHealthAvgUptime: 'Avg uptime',
        ovHealthTechSection: 'Stack mix',
        ovHealthTechSectionHint: 'Languages, package managers and combinations',
        ovHealthTechMeta: '{count} stacks',
        ovHealthResourcesSection: 'Resources & host',
        ovHealthResourcesHint: 'Last 5-minute trend and the local runtime',
        ovHealthResourcesMeta: 'every 5s',
        ovHealthProjectSection: 'Projects & rankings',
        ovHealthProjectHint: 'Project load and the app Top 5',
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
        managedBadge: 'Managed',
        unmanagedBadge: 'Unmanaged',
        externalRunning: 'External',
        externalPorts: 'port {ports}',
        takeoverApp: 'Take over',
        externalRestartHint: 'Stop the external process and restart it under dockyard (takeover).',
        takeoverAll: 'Take over all',
        takeoverAllCount: 'Take over all ({count})',
        filterUnmanaged: 'Unmanaged',
        externalAppsHint:
          'Externally started apps expose status, CPU/memory and ports only. Take over to restart under dockyard and capture logs.',
        externalUnmatchedCount: 'Unmatched external processes {count}',
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
        dockStopped: 'stopped',
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
     * @returns {Promise<{ generatedAt: number, applications: any[], externalApps: any[], externalUnmatched: number, externalError: string, projects: any[], system: any, resourceHistory: { at: number, cpuPercent: number, rssBytes: number }[], preferences: { statusBar: boolean }, warnings: string[], scanRoots: string[] }>}
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
        generatedAt: Number(body.generatedAt) || Date.now(),
        applications: Array.isArray(body.applications) ? body.applications : [],
        externalApps: Array.isArray(body.externalApps) ? body.externalApps : [],
        externalUnmatched: Number(body.externalUnmatched) || 0,
        externalError: typeof body.externalError === 'string' ? body.externalError : '',
        projects: Array.isArray(body.projects) ? body.projects : [],
        system: body.system && typeof body.system === 'object' ? body.system : null,
        // 旧 Host 没有趋势聚合字段时给空数组，趋势卡显示"暂无采样"而不是伪造曲线。
        resourceHistory: Array.isArray(body.resourceHistory)
          ? body.resourceHistory
              .filter(
                (item) =>
                  item &&
                  typeof item === 'object' &&
                  Number.isFinite(item.at) &&
                  Number.isFinite(item.cpuPercent) &&
                  Number.isFinite(item.rssBytes),
              )
              .map((item) => ({
                at: Number(item.at),
                cpuPercent: Number(item.cpuPercent),
                rssBytes: Number(item.rssBytes),
              }))
          : [],
        // 旧 Host 不返回 preferences 时保持"展示"，避免升级瞬间界面突然少一块。
        preferences: {
          statusBar:
            body.preferences && typeof body.preferences === 'object'
              ? body.preferences.statusBar !== false
              : true,
        },
        sync: body.sync && typeof body.sync === 'object' ? body.sync : null,
        syncIntervalMs: Number(body.syncIntervalMs) || 0,
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
  gap: 6px;
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
/* 分隔线放在可伸缩的间隙里：剩余宽度均匀分给各块之间，而不是堆成一个大洞。 */
.dy-gap {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-width: 5px;
  max-width: 34px;
}
.dy-bar-health { gap: 5px; }
.dy-bar-scale { gap: 10px; }
.dy-bar-res { gap: 10px; }
.dy-bar-eco { gap: 5px; flex: 0 1 auto; overflow: hidden; }
.dy-bar-spacer { flex: 1 1 auto; min-width: 4px; }
.dy-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 6px;
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
.dy-res { display: inline-flex; align-items: center; gap: 6px; flex: none; white-space: nowrap; }
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
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  flex: none;
  white-space: nowrap;
  font-size: 11px;
  line-height: 1;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
}
.dy-tag-eco b { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dy-tag-eco em {
  font-style: normal;
  color: var(--dsw-alias-label-tertiary, inherit);
}
.dy-tag-eco-count {
  color: var(--dsw-alias-label-tertiary, inherit);
  font-variant-numeric: tabular-nums;
}
.dy-tag-eco-more {
  padding: 0 5px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-variant-numeric: tabular-nums;
}
.dy-bar-actions { display: inline-flex; align-items: center; gap: 2px; flex: none; margin-left: auto; }
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
/* 窄窗口逐级降级：生态先缩成"1 组 + N"，再隐藏；规模、资源继续按优先级让位。
   稀疏时让剩余块吃掉空余宽度，避免右侧出现一片无意义的空洞。 */
.dy-tag-eco-more-narrow { display: none; }
.dy-chip-stopped { display: none; }
@container (max-width: 945px) {
  .dy-chip-stopped { display: inline-flex; }
  .dy-tag-eco-secondary,
  .dy-tag-eco-more-wide { display: none; }
  .dy-tag-eco-more-narrow { display: inline-flex; }
}
@container (max-width: 880px) {
  .dy-tag-eco-more-narrow { display: none; }
}
@container (max-width: 850px) {
  .dy-chip-stopped { display: none; }
}
@container (max-width: 800px) {
  .dy-bar-eco { display: none; }
  .dy-chip-stopped { display: inline-flex; }
}
@container (max-width: 760px) {
  .dy-bar-scale { display: none; }
}
@container (max-width: 640px) {
  .dy-bar-res { display: none; }
  .dy-bar-health { flex: 1 1 auto; justify-content: space-between; }
}

/* ── 概览：指标版 / 健康版 ──────────────────────────────────────────────
   两个 tab 共用一套卡片、图表与排版。分类色从宿主主题 token 派生，
   这里不定义第二套主题色；颜色变量集中在 .dy-ov 上。 */
.dy-ov {
  container-type: inline-size;
  container-name: dy-overview;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  --dy-cat-brand: var(--dsw-alias-brand-primary, #4d6bfe);
  --dy-cat-success: var(--dsw-alias-state-success-primary, #2ea043);
  --dy-cat-warn: var(--dsw-alias-state-warn-primary, #d29922);
  --dy-cat-error: var(--dsw-alias-state-error-primary, #f85149);
  --dy-cat-business: var(--dsw-alias-state-business-primary, #a371f7);
  --dy-cat-idle: var(--dsw-alias-state-idle-primary, #8b949e);
  --dy-cat-teal: color-mix(
    in srgb,
    var(--dsw-alias-state-success-primary, #2ea043) 55%,
    var(--dsw-alias-brand-primary, #4d6bfe)
  );
  --dy-cat-violet: color-mix(
    in srgb,
    var(--dsw-alias-state-business-primary, #a371f7) 55%,
    var(--dsw-alias-state-warn-primary, #d29922)
  );
  --dy-track: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
  --dy-surface: var(--dsw-alias-bg-layer-1, transparent);
  --dy-surface-2: var(--dsw-alias-bg-layer-2, transparent);
  --dy-border: var(--dsw-alias-border-l1, currentColor);
  --dy-border-strong: var(--dsw-alias-border-l2, currentColor);
  --dy-text: var(--dsw-alias-label-primary, inherit);
  --dy-text-2: var(--dsw-alias-label-secondary, inherit);
  --dy-text-3: var(--dsw-alias-label-tertiary, inherit);
}
.dy-ov-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dy-ov-block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.dy-ov-block-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.dy-ov-block-hint {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--dy-text-3);
}
.dy-ov-block-meta {
  font-size: 10px;
  color: var(--dy-text-3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.dy-ov-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--dy-text-3);
  font-variant-numeric: tabular-nums;
}
.dy-ov-metric-groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dy-ov-metric-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dy-ov-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--dy-text-3);
}
.dy-ov-group-line {
  flex: 1;
  height: 1px;
  background: var(--dy-border);
}
.dy-ov-group-meta {
  font-weight: 400;
  letter-spacing: 0;
  white-space: nowrap;
}
.dy-ov-metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.dy-ov-metric {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-height: 116px;
  padding: 13px 15px 12px;
  border: 1px solid var(--dy-border);
  border-radius: 12px;
  background: var(--dy-surface);
}
.dy-ov-metric::before {
  content: '';
  position: absolute;
  left: 0;
  top: 14px;
  bottom: 14px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--dy-tone, var(--dy-border-strong));
  opacity: 0.85;
}
.dy-ov-metric[data-tone='success'] {
  --dy-tone: var(--dy-cat-success);
}
.dy-ov-metric[data-tone='error'] {
  --dy-tone: var(--dy-cat-error);
}
.dy-ov-metric[data-tone='warn'] {
  --dy-tone: var(--dy-cat-warn);
}
.dy-ov-metric[data-tone='idle'] {
  --dy-tone: var(--dy-cat-idle);
}
.dy-ov-metric[data-tone='brand'] {
  --dy-tone: var(--dy-cat-brand);
}
.dy-ov-metric-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dy-ov-metric-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--dy-text-2);
}
.dy-ov-metric-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--dy-tone, var(--dy-cat-idle));
  opacity: 0.9;
}
.dy-ov-metric-value {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-size: 25px;
  font-weight: 650;
  line-height: 1.08;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.dy-ov-metric-unit {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--dy-text-2);
}
.dy-ov-metric[data-tone='success'] .dy-ov-metric-value {
  color: var(--dy-cat-success);
}
.dy-ov-metric[data-tone='error'] .dy-ov-metric-value {
  color: var(--dy-cat-error);
}
.dy-ov-metric[data-tone='warn'] .dy-ov-metric-value {
  color: var(--dy-cat-warn);
}
.dy-ov-metric[data-tone='idle'] .dy-ov-metric-value {
  color: var(--dy-text-2);
}
.dy-ov-metric-hint {
  margin-top: auto;
  font-size: 10.5px;
  line-height: 1.35;
  color: var(--dy-text-3);
}
.dy-ov-metric-bar {
  height: 3px;
  border-radius: 999px;
  background: var(--dy-track);
  overflow: hidden;
  flex: 0 0 auto;
}
.dy-ov-metric-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--dy-tone, var(--dy-cat-brand));
}
.dy-ov-metric-dots {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 0 1px;
}
.dy-ov-metric-dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.dy-ov-grid {
  display: grid;
  gap: 12px;
  align-items: stretch;
}
.dy-ov-grid-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.dy-ov-grid-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.dy-ov-grid-tech {
  grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr) minmax(0, 0.85fr);
}
.dy-ov-grid-health {
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.9fr) minmax(0, 1.2fr);
}
.dy-ov-grid-project {
  grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
}
.dy-ov-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--dy-border);
  border-radius: 12px;
  background: var(--dy-surface);
}
.dy-ov-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.dy-ov-card-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.dy-ov-card-sub {
  margin: 3px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--dy-text-3);
}
.dy-ov-card-side {
  font-size: 10px;
  color: var(--dy-text-3);
  white-space: nowrap;
}
.dy-ov-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid var(--dy-border);
  border-radius: 999px;
  background: var(--dy-surface-2);
  color: var(--dy-text-2);
  font-size: 10px;
  white-space: nowrap;
}
.dy-ov-chip.success {
  color: var(--dy-cat-success);
  background: color-mix(in srgb, var(--dy-cat-success) 12%, transparent);
  border-color: transparent;
}
.dy-ov-chip.error {
  color: var(--dy-cat-error);
  background: color-mix(in srgb, var(--dy-cat-error) 12%, transparent);
  border-color: transparent;
}
.dy-ov-chip.warn {
  color: var(--dy-cat-warn);
  background: color-mix(in srgb, var(--dy-cat-warn) 14%, transparent);
  border-color: transparent;
}
.dy-ov-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--dy-cat-idle);
}
.dy-ov-donut-layout {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 148px;
}
.dy-ov-donut {
  position: relative;
  flex: 0 0 auto;
}
.dy-ov-donut svg {
  display: block;
  width: 100%;
  height: 100%;
}
.dy-ov-donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  pointer-events: none;
}
.dy-ov-donut-center b {
  font-size: 24px;
  line-height: 1;
  font-weight: 650;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.dy-ov-donut-center span {
  font-size: 9.5px;
  color: var(--dy-text-3);
}
.dy-ov-donut-legend {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dy-ov-legend-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.dy-ov-legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.dy-ov-legend-name {
  color: var(--dy-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dy-ov-legend-value {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dy-ov-legend-pct {
  min-width: 32px;
  text-align: right;
  font-size: 10px;
  color: var(--dy-text-3);
  font-variant-numeric: tabular-nums;
}
.dy-ov-overlay-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--dy-border);
  font-size: 10px;
  color: var(--dy-text-3);
}
.dy-ov-rate-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px dashed var(--dy-border);
}
.dy-ov-rate-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 10.5px;
  color: var(--dy-text-3);
}
.dy-ov-rate-head b {
  color: var(--dy-text);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dy-ov-meter {
  height: 5px;
  border-radius: 999px;
  background: var(--dy-track);
  overflow: hidden;
}
.dy-ov-meter i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--dy-cat-brand);
}
.dy-ov-dist-list {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.dy-ov-dist-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.dy-ov-dist-top {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 11px;
}
.dy-ov-dist-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dy-ov-dist-sub {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--dy-text-3);
  white-space: nowrap;
}
.dy-ov-dist-count {
  min-width: 14px;
  margin-left: 5px;
  text-align: right;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dy-ov-dist-track {
  position: relative;
  height: 5px;
  border-radius: 999px;
  background: var(--dy-track);
  overflow: hidden;
}
.dy-ov-dist-fill,
.dy-ov-dist-run {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: inherit;
}
.dy-ov-dist-fill {
  opacity: 0.22;
}
.dy-ov-footnote {
  margin: auto 0 0;
  padding-top: 10px;
  border-top: 1px dashed var(--dy-border);
  font-size: 9.5px;
  line-height: 1.5;
  color: var(--dy-text-3);
}
.dy-ov-stack-bar {
  display: flex;
  gap: 2px;
  height: 13px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--dy-track);
}
.dy-ov-stack-seg {
  display: block;
  height: 100%;
  min-width: 4px;
  flex-basis: 0;
}
.dy-ov-tech-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
}
.dy-ov-legend-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--dy-border);
  border-radius: 999px;
  background: var(--dy-surface-2);
  font-size: 10.5px;
  color: var(--dy-text-2);
  white-space: nowrap;
}
.dy-ov-legend-chip i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dy-ov-legend-chip b {
  font-weight: 600;
  color: var(--dy-text);
  font-variant-numeric: tabular-nums;
}
.dy-ov-tech-foot {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px dashed var(--dy-border);
  font-size: 10px;
  color: var(--dy-text-3);
}
.dy-ov-trend-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dy-ov-trend-block + .dy-ov-trend-block {
  padding-top: 10px;
  border-top: 1px dashed var(--dy-border);
}
.dy-ov-trend-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
}
.dy-ov-trend-label {
  color: var(--dy-text-2);
}
.dy-ov-trend-head b {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dy-ov-trend-peak {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--dy-text-3);
  white-space: nowrap;
}
.dy-ov-spark {
  display: block;
  width: 100%;
  height: 46px;
  margin-top: 2px;
}
.dy-ov-spark-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 46px;
  margin-top: 2px;
  border: 1px dashed var(--dy-border);
  border-radius: 8px;
  background: var(--dy-surface-2);
  color: var(--dy-text-3);
  font-size: 10px;
}
.dy-ov-host-mem {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dy-ov-host-mem-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
}
.dy-ov-host-mem-top span {
  color: var(--dy-text-2);
}
.dy-ov-host-mem-top b {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dy-ov-host-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}
.dy-ov-host-kv span {
  display: block;
  font-size: 9.5px;
  color: var(--dy-text-3);
}
.dy-ov-host-kv b {
  display: block;
  margin-top: 1px;
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dy-ov-project-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px 106px;
  align-items: center;
  gap: 14px;
}
.dy-ov-project-main {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.dy-ov-project-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.dy-ov-project-name {
  font-weight: 500;
  white-space: nowrap;
}
.dy-ov-project-path {
  max-width: 230px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 9.5px;
  color: var(--dy-text-3);
}
.dy-ov-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dy-ov-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 17px;
  padding: 0 6px;
  border: 1px solid var(--dy-border);
  border-radius: 5px;
  background: var(--dy-surface-2);
  color: var(--dy-text-2);
  font-size: 9.5px;
  white-space: nowrap;
}
.dy-ov-tag-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dy-ov-tag-mgr {
  color: var(--dy-text-3);
}
.dy-ov-project-bars {
  display: flex;
  gap: 4px;
}
.dy-ov-mini-meter {
  flex: 1;
  height: 3px;
  border-radius: 999px;
  background: var(--dy-track);
  overflow: hidden;
}
.dy-ov-mini-meter i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--dy-cat-brand);
}
.dy-ov-mini-meter-mem i {
  background: var(--dy-cat-business);
}
.dy-ov-project-meta {
  text-align: right;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--dy-text-3);
}
.dy-ov-project-meta b {
  color: var(--dy-text);
  font-weight: 600;
}
.dy-ov-project-value {
  text-align: right;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--dy-text-2);
  font-variant-numeric: tabular-nums;
}
.dy-ov-project-value span {
  color: var(--dy-text-3);
}
.dy-ov-rank-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dy-ov-rank-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.dy-ov-rank-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 11px;
}
.dy-ov-rank-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dy-ov-rank-project {
  font-size: 9.5px;
  color: var(--dy-text-3);
  white-space: nowrap;
}
.dy-ov-rank-value {
  margin-left: auto;
  color: var(--dy-text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dy-ov-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--dy-border);
  border-radius: 7px;
  background: var(--dy-surface-2);
}
.dy-ov-seg-btn {
  appearance: none;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--dy-text-3);
  font: inherit;
  font-size: 10.5px;
  padding: 3px 8px;
  cursor: pointer;
}
.dy-ov-seg-btn[aria-pressed='true'] {
  background: var(--dy-surface);
  color: var(--dy-text);
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
}
.dy-ov-hint {
  margin: 0;
  font-size: 11px;
  color: var(--dy-text-3);
}
.dy-ov-list-card {
  padding: 0;
  overflow: hidden;
  gap: 0;
}
.dy-ov-list-empty {
  padding: 18px 16px;
}
.dy-ov-alert-row,
.dy-ov-run-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--dy-border);
}
.dy-ov-alert-row:first-child,
.dy-ov-run-row:first-child {
  border-top: none;
}
.dy-ov-alert-icon {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  background: color-mix(in srgb, var(--dy-cat-error) 12%, transparent);
  color: var(--dy-cat-error);
}
.dy-ov-alert-icon-warn {
  background: color-mix(in srgb, var(--dy-cat-warn) 14%, transparent);
  color: var(--dy-cat-warn);
}
.dy-ov-alert-main,
.dy-ov-run-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.dy-ov-alert-title,
.dy-ov-run-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  font-weight: 500;
}
.dy-ov-alert-meta,
.dy-ov-run-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--dy-text-3);
}
.dy-ov-row-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}
.dy-ov .dy-btn.dy-ov-btn {
  font-size: 11px;
  padding: 3px 8px;
}
.dy-ov .dy-pill {
  font-size: 10.5px;
}
.dy-ov-run-stats {
  display: flex;
  flex: 0 0 auto;
  gap: 18px;
}
.dy-ov-run-stat {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  min-width: 54px;
}
.dy-ov-run-stat b {
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dy-ov-run-stat span {
  font-size: 9.5px;
  color: var(--dy-text-3);
}
.dy-ov-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) 170px minmax(0, 1fr);
  align-items: center;
  gap: 26px;
  padding: 22px 24px;
}
.dy-ov-hero-kicker {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--dy-text-3);
}
.dy-ov-hero-number {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 7px;
}
.dy-ov-hero-number b {
  font-size: 44px;
  line-height: 1;
  font-weight: 650;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
}
.dy-ov-hero-number span {
  font-size: 12px;
  color: var(--dy-text-3);
}
.dy-ov-hero-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.dy-ov-hero-kpis {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-top: 16px;
  padding-top: 13px;
  border-top: 1px solid var(--dy-border);
}
.dy-ov-hero-kpi span {
  display: block;
  font-size: 9.5px;
  color: var(--dy-text-3);
}
.dy-ov-hero-kpi b {
  display: block;
  margin-top: 1px;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dy-ov-hero-donut {
  display: flex;
  align-items: center;
  justify-content: center;
}
.dy-ov-hero-res {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-left: 22px;
  border-left: 1px solid var(--dy-border);
  min-width: 0;
}
.dy-ov-compact-alerts {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dy-ov-compact-alert {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dy-ov-compact-alert + .dy-ov-compact-alert {
  padding-top: 10px;
  border-top: 1px solid var(--dy-border);
}
.dy-ov-warning-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--dy-text-2);
}
@container dy-overview (max-width: 900px) {
  .dy-ov-metric-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .dy-ov-grid-3,
  .dy-ov-grid-2,
  .dy-ov-grid-tech,
  .dy-ov-grid-health,
  .dy-ov-grid-project {
    grid-template-columns: 1fr;
  }
  .dy-ov-hero {
    grid-template-columns: minmax(0, 1fr) 150px;
  }
  .dy-ov-hero-res {
    grid-column: 1 / -1;
    padding: 14px 0 0;
    border-top: 1px solid var(--dy-border);
    border-left: none;
  }
  .dy-ov-project-row {
    grid-template-columns: minmax(0, 1fr) 76px;
  }
  .dy-ov-project-value {
    display: none;
  }
}
@container dy-overview (max-width: 620px) {
  .dy-ov-metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .dy-ov-hero {
    grid-template-columns: 1fr;
  }
  .dy-ov-hero-donut {
    justify-content: flex-start;
  }
  .dy-ov-donut-layout {
    flex-direction: column;
    align-items: flex-start;
  }
  .dy-ov-project-path {
    display: none;
  }
  .dy-ov-run-stats {
    gap: 10px;
  }
  .dy-ov-run-meta {
    display: none;
  }
  .dy-ov-alert-row,
  .dy-ov-run-row {
    flex-wrap: wrap;
  }
  .dy-ov-row-actions {
    width: 100%;
    justify-content: flex-end;
  }
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
     * 概览专用格式化：保留两位小数的大小，与设计稿一致。
     * 现有 formatBytes 只保留一位小数，服务页继续用它，概览这里单独一套。
     * @param {number | undefined} bytes
     * @returns {string}
     */
    function formatSizeDetailed(bytes) {
      if (!Number.isFinite(bytes) || Number(bytes) <= 0) return '0 B';
      const value = Number(bytes);
      if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
      if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${Math.round(value)} B`;
    }

    /**
     * 把字节拆成"数值 + 单位"，供指标卡的两个字号使用。
     * @param {number | undefined} bytes
     * @returns {{ value: string, unit: string }}
     */
    function sizeParts(bytes) {
      if (!Number.isFinite(bytes) || Number(bytes) <= 0) return { value: '0', unit: 'B' };
      const value = Number(bytes);
      if (value >= 1024 ** 3) return { value: (value / 1024 ** 3).toFixed(2), unit: 'GB' };
      if (value >= 1024 ** 2) return { value: String(Math.round(value / 1024 ** 2)), unit: 'MB' };
      if (value >= 1024) return { value: String(Math.round(value / 1024)), unit: 'KB' };
      return { value: String(Math.round(value)), unit: 'B' };
    }

    /**
     * 毫秒拆成"小时 + 分钟"两段；分钟部分补零，和设计稿的 3h 08m 一致。
     * @param {number | undefined} ms
     * @returns {{ value: string, unit: string }}
     */
    function durationParts(ms) {
      if (!Number.isFinite(ms) || Number(ms) <= 0) return { value: '—', unit: '' };
      const minutes = Math.floor(Number(ms) / 60000);
      if (minutes < 60) return { value: `${minutes}m`, unit: '' };
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return { value: `${hours}h`, unit: `${String(minutes % 60).padStart(2, '0')}m` };
      }
      const days = Math.floor(hours / 24);
      return { value: `${days}d`, unit: `${String(hours % 24).padStart(2, '0')}h` };
    }

    /**
     * @param {number | undefined} ms
     * @param {(key: string) => string} t
     * @returns {string}
     */
    function formatDurationDetailed(ms, t) {
      const parts = durationParts(ms);
      if (parts.value === '—') return t('never');
      return parts.unit === '' ? parts.value : `${parts.value} ${parts.unit}`;
    }

    /**
     * 分布图用整数百分比，避免 45.45% 这种噪音。
     * @param {number | undefined} value
     * @param {string} never
     * @returns {string}
     */
    function formatWholePercent(value, never) {
      return Number.isFinite(value) ? `${Math.round(Number(value))}%` : never;
    }

    /** @param {number | undefined} value */
    function clampPercent(value) {
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(100, Number(value)));
    }

    /**
     * @param {number} value
     * @returns {string}
     */
    function formatClock(value) {
      const date = new Date(Number(value) || Date.now());
      return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
    }

    /** @param {string | undefined} platform */
    function platformLabel(platform) {
      if (platform === 'darwin') return 'macOS';
      if (platform === 'win32') return 'Windows';
      if (platform === 'linux') return 'Linux';
      return platform || '—';
    }

    /** 语言 → 主题 token 派生的分类色。不写死字面色，跟随宿主明暗主题。 */
    const OVERVIEW_LANGUAGE_COLORS = {
      Java: '--dy-cat-warn',
      'Node.js': '--dy-cat-success',
      Python: '--dy-cat-brand',
      Go: '--dy-cat-business',
      Flutter: '--dy-cat-teal',
      PHP: '--dy-cat-violet',
      Rust: '--dy-cat-error',
      Shell: '--dy-cat-idle',
    };

    /** 包管理器 → 分类色；同一个语言下的 npm/pnpm/yarn 不共用一种颜色。 */
    const OVERVIEW_MANAGER_COLORS = {
      pnpm: '--dy-cat-success',
      npm: '--dy-cat-warn',
      yarn: '--dy-cat-brand',
      bun: '--dy-cat-business',
      Maven: '--dy-cat-warn',
      Gradle: '--dy-cat-business',
      uv: '--dy-cat-brand',
      poetry: '--dy-cat-violet',
      pip: '--dy-cat-teal',
      Composer: '--dy-cat-violet',
      pub: '--dy-cat-teal',
      'Go Modules': '--dy-cat-business',
      Cargo: '--dy-cat-error',
      '—': '--dy-cat-idle',
    };

    /**
     * @param {Record<string, string>} map
     * @param {string} name
     * @returns {string}
     */
    function categoryColor(map, name) {
      const variable = map[name] ?? '--dy-cat-idle';
      return `var(${variable})`;
    }

    /**
     * 按某个字段把应用分组，并统计应用数、运行中数量与覆盖项目数。
     * 空值单列成"未知"，不合并进任何真实分类。
     * @param {any[]} apps
     * @param {string} field
     * @returns {{ name: string, count: number, running: number, projects: number, language: string }[]}
     */
    function groupOverviewApps(apps, field) {
      /** @type {Map<string, { name: string, count: number, running: number, projects: Set<string>, language: string }>} */
      const groups = new Map();
      for (const app of apps) {
        const raw = app[field];
        const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '';
        const key = name === '' ? '__unknown__' : name;
        let group = groups.get(key);
        if (!group) {
          group = {
            name,
            count: 0,
            running: 0,
            projects: new Set(),
            language: typeof app.language === 'string' ? app.language : '',
          };
          groups.set(key, group);
        }
        group.count += 1;
        if (app.status === 'running') group.running += 1;
        group.projects.add(app.projectId ?? 'unclassified');
      }
      return [...groups.values()]
        .map((group) => ({ ...group, projects: group.projects.size }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            b.running - a.running ||
            String(a.name).localeCompare(String(b.name)),
        );
    }

    /**
     * 旧 Host 没有 projects 字段时的客户端兜底聚合。
     * @param {any[]} apps
     * @returns {any[]}
     */
    function aggregateOverviewProjects(apps) {
      /** @type {Map<string, any>} */
      const groups = new Map();
      for (const app of apps) {
        const key = app.projectId ?? 'unclassified';
        let group = groups.get(key);
        if (!group) {
          group = {
            id: key,
            name: app.projectName ?? '',
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
          group.cpuPercent += Number(app.cpuPercent) || 0;
          group.rssBytes += Number(app.rssBytes) || 0;
        }
      }
      return [...groups.values()];
    }

    /**
     * 把 status 归一化成概览需要的一份模型。两个概览 tab 共用。
     * @param {any} status
     * @returns {any}
     */
    function buildOverviewModel(status) {
      const apps = Array.isArray(status.applications) ? status.applications : [];
      const running = apps.filter((app) => app.status === 'running');
      const crashed = apps.filter((app) => app.status === 'crashed');
      const stopped = apps.filter((app) => app.status === 'stopped');
      const missing = apps.filter((app) => app.missing === true);
      const restartRequired = apps.filter((app) => app.restartRequired === true);
      const severity = (app) =>
        app.status === 'crashed'
          ? 0
          : app.missing === true
            ? 1
            : app.restartRequired === true
              ? 2
              : 3;
      const attention = apps
        .filter(
          (app) => app.status === 'crashed' || app.missing === true || app.restartRequired === true,
        )
        .sort((a, b) => severity(a) - severity(b) || String(a.name).localeCompare(String(b.name)));
      const totalCpu = running.reduce((sum, app) => sum + (Number(app.cpuPercent) || 0), 0);
      const totalRss = running.reduce((sum, app) => sum + (Number(app.rssBytes) || 0), 0);
      const avgUptime = running.length
        ? running.reduce((sum, app) => sum + (Number(app.uptimeMs) || 0), 0) / running.length
        : 0;
      const longest = [...running].sort(
        (a, b) => (Number(b.uptimeMs) || 0) - (Number(a.uptimeMs) || 0),
      )[0];
      const languageStats = groupOverviewApps(apps, 'language');
      const managerStats = groupOverviewApps(apps, 'manager');
      const ecoStats = groupOverviewApps(apps, 'ecosystemName');
      const managerKinds = managerStats.filter(
        (item) => item.name !== '' && item.name !== '—',
      ).length;
      const sourceProjects =
        Array.isArray(status.projects) && status.projects.length > 0
          ? status.projects
          : aggregateOverviewProjects(apps);
      const projects = sourceProjects.map((project) => {
        const projectApps = apps.filter((app) => (app.projectId ?? 'unclassified') === project.id);
        const projectRunning = projectApps.filter((app) => app.status === 'running');
        return {
          id: project.id,
          name: project.name || '',
          root: project.root || '',
          apps: Number.isFinite(project.apps) ? project.apps : projectApps.length,
          running: Number.isFinite(project.running) ? project.running : projectRunning.length,
          cpuPercent: Number.isFinite(project.cpuPercent)
            ? project.cpuPercent
            : projectRunning.reduce((sum, app) => sum + (Number(app.cpuPercent) || 0), 0),
          rssBytes: Number.isFinite(project.rssBytes)
            ? project.rssBytes
            : projectRunning.reduce((sum, app) => sum + (Number(app.rssBytes) || 0), 0),
          languages: [...new Set(projectApps.map((app) => app.language).filter((item) => item))],
          managers: [
            ...new Set(
              projectApps.map((app) => app.manager).filter((item) => item && item !== '—'),
            ),
          ],
        };
      });
      projects.sort((a, b) => b.running - a.running || b.cpuPercent - a.cpuPercent);
      const history = Array.isArray(status.resourceHistory)
        ? status.resourceHistory.slice(-60)
        : [];
      const cpuPeak = history.length
        ? Math.max(...history.map((sample) => Number(sample.cpuPercent) || 0))
        : null;
      const rssPeak = history.length
        ? Math.max(...history.map((sample) => Number(sample.rssBytes) || 0))
        : null;
      return {
        apps,
        running,
        crashed,
        stopped,
        missing,
        restartRequired,
        attention,
        totalCpu,
        totalRss,
        avgUptime,
        longest,
        languageStats,
        managerStats,
        ecoStats,
        managerKinds,
        projects,
        history,
        cpuPeak,
        rssPeak,
        system: status.system,
        generatedAt: status.generatedAt,
      };
    }

    /**
     * 概览里的通用卡片头。
     * @param {{ title: string, subtitle?: string, side?: any }} props
     */
    function OverviewCardHead(props) {
      return h(
        'div',
        { className: 'dy-ov-card-head' },
        h(
          'div',
          null,
          h('h3', { className: 'dy-ov-card-title' }, props.title),
          props.subtitle ? h('p', { className: 'dy-ov-card-sub' }, props.subtitle) : null,
        ),
        props.side === undefined || props.side === null
          ? null
          : h('span', { className: 'dy-ov-card-side' }, props.side),
      );
    }

    /**
     * 概览 section 头：标题 + 说明 + 右侧元信息。
     * @param {{ title: any, hint?: string, meta?: any }} props
     */
    function OverviewBlockHead(props) {
      return h(
        'div',
        { className: 'dy-ov-block-head' },
        h(
          'div',
          null,
          h('h2', { className: 'dy-ov-block-title' }, props.title),
          props.hint ? h('p', { className: 'dy-ov-block-hint' }, props.hint) : null,
        ),
        props.meta === undefined || props.meta === null
          ? null
          : h('span', { className: 'dy-ov-block-meta' }, props.meta),
      );
    }

    /**
     * 环形图。颜色由调用方传入主题 token；缺口用 stroke-dasharray 留。
     * @param {{ segments: { label: string, value: number, color: string }[], centerValue: string | number, centerLabel: string, ariaLabel: string, size?: number }} props
     */
    function OverviewDonut(props) {
      const size = props.size ?? 148;
      const stroke = 15;
      const radius = (size - stroke) / 2;
      const center = size / 2;
      const circumference = 2 * Math.PI * radius;
      const total = props.segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
      let offset = 0;
      const circles = props.segments.map((segment) => {
        const length = (segment.value / total) * circumference;
        const gap = Math.min(3.5, length * 0.25);
        const dash = Math.max(0.001, length - gap);
        const circle = h(
          'circle',
          {
            key: segment.label,
            cx: center,
            cy: center,
            r: radius,
            fill: 'none',
            stroke: segment.color,
            strokeWidth: stroke,
            strokeLinecap: 'round',
            strokeDasharray: `${dash} ${circumference - dash}`,
            strokeDashoffset: -offset,
            transform: `rotate(-90 ${center} ${center})`,
          },
          h('title', null, `${segment.label} ${segment.value}`),
        );
        offset += length;
        return circle;
      });
      return h(
        'div',
        { className: 'dy-ov-donut', style: { width: `${size}px`, height: `${size}px` } },
        h(
          'svg',
          {
            viewBox: `0 0 ${size} ${size}`,
            role: 'img',
            'aria-label': props.ariaLabel,
          },
          h('circle', {
            cx: center,
            cy: center,
            r: radius,
            fill: 'none',
            stroke: 'var(--dy-track)',
            strokeWidth: stroke,
          }),
          ...circles,
        ),
        h(
          'div',
          { className: 'dy-ov-donut-center' },
          h('b', null, String(props.centerValue)),
          h('span', null, props.centerLabel),
        ),
      );
    }

    /**
     * 迷你折线。没有采样点时显示明确文案，不画一条假线。
     * @param {{ values: number[], color: string, label: string, gradientId: string, emptyText: string, height?: number }} props
     */
    function OverviewSparkline(props) {
      if (!props.values.length) {
        return h('div', { className: 'dy-ov-spark-empty' }, props.emptyText);
      }
      const values = props.values.length === 1 ? [props.values[0], props.values[0]] : props.values;
      const width = 300;
      const height = props.height ?? 46;
      const padding = 4;
      const min = Math.min(...props.values);
      const max = Math.max(...props.values);
      const span = max - min || 1;
      const low = min - span * 0.15;
      const high = max + span * 0.15;
      const points = values.map((value, index) => [
        (index / (values.length - 1)) * width,
        height - padding - ((value - low) / (high - low)) * (height - padding * 2),
      ]);
      const line = points
        .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
        .join(' ');
      const area = `M0,${height} L${points
        .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
        .join(' L')} L${width},${height} Z`;
      const lastPoint = points[points.length - 1];
      return h(
        'svg',
        {
          className: 'dy-ov-spark',
          viewBox: `0 0 ${width} ${height}`,
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': props.label,
        },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: props.gradientId, x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0', stopColor: props.color, stopOpacity: 0.26 }),
            h('stop', { offset: '1', stopColor: props.color, stopOpacity: 0 }),
          ),
        ),
        h('path', { d: area, fill: `url(#${props.gradientId})` }),
        h('path', {
          d: line,
          fill: 'none',
          stroke: props.color,
          strokeWidth: 1.6,
          vectorEffect: 'non-scaling-stroke',
        }),
        h('circle', {
          cx: lastPoint[0].toFixed(2),
          cy: lastPoint[1].toFixed(2),
          r: 2.4,
          fill: props.color,
        }),
      );
    }

    /**
     * 指标卡。bar 为 0 也要画出来；不传 bar 才完全不画。
     * @param {{ label: string, value: string, unit?: string, hint: string, tone?: string, bar?: number, dots?: { label: string, color: string }[] }} props
     */
    function OverviewMetric(props) {
      return h(
        'div',
        { className: 'dy-ov-metric', 'data-tone': props.tone ?? 'neutral' },
        h(
          'div',
          { className: 'dy-ov-metric-top' },
          h('span', { className: 'dy-ov-metric-label' }, props.label),
          h('span', { className: 'dy-ov-metric-dot' }),
        ),
        h(
          'div',
          { className: 'dy-ov-metric-value' },
          String(props.value),
          props.unit ? h('span', { className: 'dy-ov-metric-unit' }, props.unit) : null,
        ),
        props.dots
          ? h(
              'div',
              { className: 'dy-ov-metric-dots' },
              ...props.dots.map((dot) =>
                h('i', { key: dot.label, style: { background: dot.color }, title: dot.label }),
              ),
            )
          : null,
        h('div', { className: 'dy-ov-metric-hint' }, props.hint),
        props.bar === undefined
          ? null
          : h(
              'div',
              { className: 'dy-ov-metric-bar' },
              h('i', { style: { width: `${clampPercent(props.bar)}%` } }),
            ),
      );
    }

    /**
     * @param {{ title: string, meta: string, metrics: any[] }} props
     */
    function OverviewMetricGroup(props) {
      return h(
        'div',
        { className: 'dy-ov-metric-group' },
        h(
          'div',
          { className: 'dy-ov-group-head' },
          h('span', null, props.title),
          h('span', { className: 'dy-ov-group-line' }),
          h('span', { className: 'dy-ov-group-meta' }, props.meta),
        ),
        h('div', { className: 'dy-ov-metric-grid' }, ...props.metrics),
      );
    }

    /**
     * 概览：状态、规模、资源三组指标。
     * @param {{ model: any, t: (key: string) => string }} props
     */
    function OverviewMetricGroups(props) {
      const { model, t } = props;
      const total = model.apps.length || 1;
      const languageLead = model.languageStats[0];
      const managerLead = model.managerStats[0];
      const statusMetrics = [
        h(OverviewMetric, {
          key: 'running',
          label: t('statRunning'),
          value: String(model.running.length),
          hint: `${formatWholePercent((model.running.length / total) * 100, t('never'))} · ${
            model.running.length
          }/${model.apps.length} ${t('ovLabelApps')}`,
          tone: 'success',
          bar: (model.running.length / total) * 100,
        }),
        h(OverviewMetric, {
          key: 'crashed',
          label: t('statCrashed'),
          value: String(model.crashed.length),
          hint: model.crashed.length ? t('ovCrashedHint') : t('attentionEmpty'),
          tone: 'error',
          bar: (model.crashed.length / total) * 100,
        }),
        h(OverviewMetric, {
          key: 'stopped',
          label: t('statStopped'),
          value: String(model.stopped.length),
          hint: format(t('ovStoppedHint'), { count: model.stopped.length }),
          tone: 'idle',
          bar: (model.stopped.length / total) * 100,
        }),
        h(OverviewMetric, {
          key: 'attention',
          label: t('ovLabelAttention'),
          value: String(model.attention.length),
          hint: format(t('ovAttentionHint'), {
            crashed: model.crashed.length,
            missing: model.missing.length,
            restart: model.restartRequired.length,
          }),
          tone: 'warn',
          bar: (model.attention.length / total) * 100,
        }),
      ];
      const scaleMetrics = [
        h(OverviewMetric, {
          key: 'projects',
          label: t('statProjects'),
          value: String(model.projects.length),
          hint: format(t('ovStatProjectsHint'), {
            apps: model.apps.length,
            avg: (model.apps.length / (model.projects.length || 1)).toFixed(1),
          }),
        }),
        h(OverviewMetric, {
          key: 'apps',
          label: t('ovLabelApps'),
          value: String(model.apps.length),
          hint: format(t('ovStatAppsHint'), {
            running: model.running.length,
            idle: model.apps.length - model.running.length,
          }),
        }),
        h(OverviewMetric, {
          key: 'languages',
          label: t('ovLabelLanguages'),
          value: String(model.languageStats.length),
          hint: languageLead
            ? format(t('ovStatLanguagesHint'), {
                name: languageLead.name || t('languageUnknown'),
                count: languageLead.count,
              })
            : t('languageUnknown'),
          dots: model.languageStats.map((group) => ({
            label: `${group.name || t('languageUnknown')} ${group.count}`,
            color: categoryColor(OVERVIEW_LANGUAGE_COLORS, group.name),
          })),
        }),
        h(OverviewMetric, {
          key: 'managers',
          label: t('ovLabelManagers'),
          value: String(model.managerKinds),
          hint: managerLead
            ? format(t('ovStatManagersHint'), {
                name: managerLead.name || t('ovManagerUndeclared'),
                count: managerLead.count,
              })
            : t('ovManagerUndeclared'),
          dots: model.managerStats.map((group) => ({
            label: `${group.name || t('ovManagerUndeclared')} ${group.count}`,
            color: categoryColor(OVERVIEW_MANAGER_COLORS, group.name),
          })),
        }),
      ];
      const memoryParts = sizeParts(model.totalRss);
      const avgParts = durationParts(model.avgUptime);
      const longestParts = durationParts(model.longest?.uptimeMs);
      const resourceMetrics = [
        h(OverviewMetric, {
          key: 'cpu',
          label: t('statCpu'),
          value: model.totalCpu.toFixed(1),
          unit: '%',
          tone: 'brand',
          hint: format(t('ovStatCpuHint'), {
            peak: model.cpuPeak === null ? t('never') : formatPercent(model.cpuPeak, t('never')),
            running: model.running.length,
          }),
          bar: model.totalCpu,
        }),
        h(OverviewMetric, {
          key: 'memory',
          label: t('statMemory'),
          value: memoryParts.value,
          unit: memoryParts.unit,
          tone: 'brand',
          hint: format(t('ovStatMemoryHint'), {
            percent: formatWholePercent(
              model.system && Number(model.system.totalmem) > 0
                ? (model.totalRss / Number(model.system.totalmem)) * 100
                : null,
              t('never'),
            ),
            peak: model.rssPeak === null ? t('never') : formatSizeDetailed(model.rssPeak),
          }),
          bar:
            model.system && Number(model.system.totalmem) > 0
              ? (model.totalRss / Number(model.system.totalmem)) * 100
              : 0,
        }),
        h(OverviewMetric, {
          key: 'avg',
          label: t('ovLabelAvgUptime'),
          value: avgParts.value,
          unit: avgParts.unit,
          hint: format(t('ovStatAvgUptimeHint'), { running: model.running.length }),
        }),
        h(OverviewMetric, {
          key: 'longest',
          label: t('ovLabelLongest'),
          value: longestParts.value,
          unit: longestParts.unit,
          hint: model.longest
            ? format(t('ovStatLongestHint'), { name: model.longest.name })
            : t('runningEmpty'),
        }),
      ];
      return h(
        'div',
        { className: 'dy-ov-metric-groups' },
        h(OverviewMetricGroup, {
          title: t('ovGroupStatus'),
          meta: format(t('ovGroupStatusMeta'), {
            apps: model.apps.length,
            projects: model.projects.length,
          }),
          metrics: statusMetrics,
        }),
        h(OverviewMetricGroup, {
          title: t('ovGroupScale'),
          meta: t('ovGroupScaleMeta'),
          metrics: scaleMetrics,
        }),
        h(OverviewMetricGroup, {
          title: t('ovGroupResources'),
          meta: t('ovGroupResourcesMeta'),
          metrics: resourceMetrics,
        }),
      );
    }

    /**
     * @param {{ languages: string[], managers: string[], t: (key: string) => string }} props
     */
    function OverviewTags(props) {
      return h(
        'div',
        { className: 'dy-ov-tags' },
        ...props.languages.map((language) =>
          h(
            'span',
            { key: `lang:${language}`, className: 'dy-ov-tag' },
            h('i', {
              className: 'dy-ov-tag-dot',
              style: { background: categoryColor(OVERVIEW_LANGUAGE_COLORS, language) },
            }),
            language,
          ),
        ),
        ...props.managers.map((manager) =>
          h('span', { key: `mgr:${manager}`, className: 'dy-ov-tag dy-ov-tag-mgr' }, manager),
        ),
      );
    }

    /**
     * @param {{ model: any, t: (key: string) => string }} props
     */
    function OverviewStatusCard(props) {
      const { model, t } = props;
      const total = model.apps.length || 1;
      const segments = [
        {
          label: t('statusRunning'),
          value: model.running.length,
          color: 'var(--dsw-alias-state-success-primary, #2ea043)',
        },
        {
          label: t('statusCrashed'),
          value: model.crashed.length,
          color: 'var(--dsw-alias-state-error-primary, #f85149)',
        },
        {
          label: t('statusStopped'),
          value: model.stopped.length,
          color: 'var(--dsw-alias-state-idle-primary, #8b949e)',
        },
      ];
      return h(
        'div',
        { className: 'dy-ov-card' },
        h(OverviewCardHead, {
          title: t('ovStatusTitle'),
          subtitle: t('ovStatusSubtitle'),
          side: format(t('ovStatusMeta'), { count: model.apps.length }),
        }),
        h(
          'div',
          { className: 'dy-ov-donut-layout' },
          h(OverviewDonut, {
            segments,
            centerValue: model.apps.length,
            centerLabel: t('ovLabelApps'),
            ariaLabel: segments.map((segment) => `${segment.label} ${segment.value}`).join('，'),
          }),
          h(
            'div',
            { className: 'dy-ov-donut-legend' },
            ...segments.map((segment) =>
              h(
                'div',
                { key: segment.label, className: 'dy-ov-legend-row' },
                h('i', { className: 'dy-ov-legend-dot', style: { background: segment.color } }),
                h('span', { className: 'dy-ov-legend-name' }, segment.label),
                h('span', { className: 'dy-ov-legend-value' }, String(segment.value)),
                h(
                  'span',
                  { className: 'dy-ov-legend-pct' },
                  formatWholePercent((segment.value / total) * 100, t('never')),
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dy-ov-overlay-note' },
          h('span', null, t('ovStatusOverlay')),
          h(
            'span',
            { className: 'dy-ov-chip warn' },
            format(t('ovStatusMissing'), { count: model.missing.length }),
          ),
          h(
            'span',
            { className: 'dy-ov-chip warn' },
            format(t('ovStatusRestart'), { count: model.restartRequired.length }),
          ),
        ),
        h(
          'div',
          { className: 'dy-ov-rate-foot' },
          h(
            'div',
            { className: 'dy-ov-rate-head' },
            h('span', null, t('ovStatusRunRate')),
            h('b', null, formatWholePercent((model.running.length / total) * 100, t('never'))),
          ),
          h(
            'div',
            { className: 'dy-ov-meter' },
            h('i', { style: { width: `${(model.running.length / total) * 100}%` } }),
          ),
        ),
      );
    }

    /**
     * 语言 / 包管理器分布共用一张卡。
     * @param {{ t: any, title: string, subtitle: string, footnote: string, items: any[], colorOf: (name: string) => string, nameOf: (name: string) => string }} props
     */
    function OverviewDistributionCard(props) {
      const max = Math.max(...props.items.map((item) => item.count), 1);
      return h(
        'div',
        { className: 'dy-ov-card' },
        h(OverviewCardHead, {
          title: props.title,
          subtitle: props.subtitle,
          side: format(props.t('ovDistKinds'), { count: props.items.length }),
        }),
        h(
          'div',
          { className: 'dy-ov-dist-list' },
          ...props.items.map((item) => {
            const color = props.colorOf(item.name);
            return h(
              'div',
              {
                key: item.name || 'unknown',
                className: 'dy-ov-dist-row',
                title: format(props.t('ovDistTitle'), {
                  name: props.nameOf(item.name),
                  count: item.count,
                  running: item.running,
                }),
              },
              h(
                'div',
                { className: 'dy-ov-dist-top' },
                h('i', { className: 'dy-ov-dot', style: { background: color } }),
                h('span', { className: 'dy-ov-dist-name' }, props.nameOf(item.name)),
                h(
                  'span',
                  { className: 'dy-ov-dist-sub' },
                  format(props.t('ovDistSub'), {
                    running: item.running,
                    projects: item.projects,
                  }),
                ),
                h('span', { className: 'dy-ov-dist-count' }, String(item.count)),
              ),
              h(
                'div',
                { className: 'dy-ov-dist-track' },
                h('span', {
                  className: 'dy-ov-dist-fill',
                  style: {
                    width: `${(item.count / max) * 100}%`,
                    background: color,
                  },
                }),
                h('span', {
                  className: 'dy-ov-dist-run',
                  style: {
                    width: `${(item.running / max) * 100}%`,
                    background: color,
                  },
                }),
              ),
            );
          }),
        ),
        h('p', { className: 'dy-ov-footnote' }, props.footnote),
      );
    }

    /**
     * @param {{ model: any, t: any }} props
     */
    function OverviewLanguageCard(props) {
      const { model, t } = props;
      return h(OverviewDistributionCard, {
        t,
        title: t('ovLanguageTitle'),
        subtitle: t('ovLanguageSubtitle'),
        footnote: t('ovLanguageFootnote'),
        items: model.languageStats,
        colorOf: (name) => categoryColor(OVERVIEW_LANGUAGE_COLORS, name || '__unknown__'),
        nameOf: (name) => name || t('languageUnknown'),
      });
    }

    /**
     * @param {{ model: any, t: any }} props
     */
    function OverviewManagerCard(props) {
      const { model, t } = props;
      return h(OverviewDistributionCard, {
        t,
        title: t('ovManagerTitle'),
        subtitle: t('ovManagerSubtitle'),
        footnote: t('ovManagerFootnote'),
        items: model.managerStats,
        colorOf: (name) => categoryColor(OVERVIEW_MANAGER_COLORS, name || '—'),
        nameOf: (name) => name || t('ovManagerUndeclared'),
      });
    }

    /**
     * @param {{ model: any, t: any }} props
     */
    function OverviewTechCard(props) {
      const { model, t } = props;
      const total = model.apps.length || 1;
      const top = model.ecoStats[0];
      return h(
        'div',
        { className: 'dy-ov-card' },
        h(OverviewCardHead, {
          title: t('ovTechTitle'),
          subtitle: t('ovTechSubtitle'),
          side: format(t('ovTechKinds'), { count: model.ecoStats.length }),
        }),
        h(
          'div',
          {
            className: 'dy-ov-stack-bar',
            role: 'img',
            'aria-label': format(t('ovTechAria'), {
              detail: model.ecoStats
                .map((item) => `${item.name || t('languageUnknown')} ${item.count}`)
                .join('，'),
            }),
          },
          ...model.ecoStats.map((item) =>
            h('span', {
              key: item.name || 'unknown',
              className: 'dy-ov-stack-seg',
              style: {
                flexGrow: item.count,
                background: categoryColor(OVERVIEW_LANGUAGE_COLORS, item.language),
              },
              title: `${item.name || t('languageUnknown')} ${item.count}`,
            }),
          ),
        ),
        h(
          'div',
          { className: 'dy-ov-tech-legend' },
          ...model.ecoStats.map((item) =>
            h(
              'span',
              { key: item.name || 'unknown', className: 'dy-ov-legend-chip' },
              h('i', {
                style: {
                  background: categoryColor(OVERVIEW_LANGUAGE_COLORS, item.language),
                },
              }),
              item.name || t('languageUnknown'),
              h('b', null, String(item.count)),
            ),
          ),
        ),
        h(
          'p',
          { className: 'dy-ov-tech-foot' },
          top
            ? format(t('ovTechFoot'), {
                name: top.name || t('languageUnknown'),
                percent: formatWholePercent((top.count / total) * 100, t('never')),
                projects: top.projects,
              })
            : t('ovTechEmpty'),
        ),
      );
    }

    /**
     * @param {{ model: any, t: any, gradientPrefix?: string }} props
     */
    function OverviewResourceTrendCard(props) {
      const { model, t } = props;
      const history = model.history;
      const cpuValues = history.map((sample) => Number(sample.cpuPercent) || 0);
      const rssValues = history.map((sample) => Number(sample.rssBytes) || 0);
      return h(
        'div',
        { className: 'dy-ov-card' },
        h(OverviewCardHead, {
          title: t('ovResourceTitle'),
          subtitle: format(t('ovResourceSubtitle'), { count: history.length }),
          side: t('ovResourceInterval'),
        }),
        h(
          'div',
          { className: 'dy-ov-trend-block' },
          h(
            'div',
            { className: 'dy-ov-trend-head' },
            h('span', { className: 'dy-ov-trend-label' }, t('ovResourceCpu')),
            h('b', null, formatPercent(model.totalCpu, t('never'))),
            h(
              'span',
              { className: 'dy-ov-trend-peak' },
              format(t('ovResourcePeak'), {
                value:
                  model.cpuPeak === null ? t('never') : formatPercent(model.cpuPeak, t('never')),
              }),
            ),
          ),
          h(OverviewSparkline, {
            values: cpuValues,
            color: 'var(--dy-cat-brand)',
            label: t('ovResourceTitle'),
            gradientId: `${props.gradientPrefix ?? 'dy-ov'}-spark-cpu`,
            emptyText: t('ovResourceEmpty'),
          }),
        ),
        h(
          'div',
          { className: 'dy-ov-trend-block' },
          h(
            'div',
            { className: 'dy-ov-trend-head' },
            h('span', { className: 'dy-ov-trend-label' }, t('ovResourceMemory')),
            h('b', null, formatSizeDetailed(model.totalRss)),
            h(
              'span',
              { className: 'dy-ov-trend-peak' },
              format(t('ovResourcePeak'), {
                value: model.rssPeak === null ? t('never') : formatSizeDetailed(model.rssPeak),
              }),
            ),
          ),
          h(OverviewSparkline, {
            values: rssValues,
            color: 'var(--dy-cat-business)',
            label: t('ovResourceMemory'),
            gradientId: `${props.gradientPrefix ?? 'dy-ov'}-spark-rss`,
            emptyText: t('ovResourceEmpty'),
          }),
        ),
        h('p', { className: 'dy-ov-footnote' }, t('ovResourceFootnote')),
      );
    }

    /**
     * @param {{ model: any, t: any }} props
     */
    function OverviewHostCard(props) {
      const { model, t } = props;
      const system = model.system;
      const totalBytes = system ? Number(system.totalmem) || 0 : 0;
      const freeBytes = system ? Number(system.freemem) || 0 : 0;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
      const gigabytes = 1024 ** 3;
      const loads = system && Array.isArray(system.loadavg) ? system.loadavg.slice(0, 3) : [];
      return h(
        'div',
        { className: 'dy-ov-card' },
        h(OverviewCardHead, {
          title: t('ovHostTitle'),
          subtitle: t('ovHostSubtitle'),
          side: system ? platformLabel(system.platform) : t('never'),
        }),
        h(
          'div',
          { className: 'dy-ov-host-mem' },
          h(
            'div',
            { className: 'dy-ov-host-mem-top' },
            h('span', null, t('ovHostMemory')),
            h(
              'b',
              null,
              totalBytes > 0
                ? format(t('ovHostMemoryValue'), {
                    used: (usedBytes / gigabytes).toFixed(1),
                    total: String(Math.round(totalBytes / gigabytes)),
                  })
                : t('never'),
            ),
          ),
          h('div', { className: 'dy-ov-meter' }, h('i', { style: { width: `${usedPercent}%` } })),
        ),
        h(
          'div',
          { className: 'dy-ov-host-grid' },
          h(
            'div',
            { className: 'dy-ov-host-kv' },
            h('span', null, t('ovHostLoad')),
            h(
              'b',
              null,
              loads.length
                ? loads.map((value) => Number(value).toFixed(2)).join(' / ')
                : t('never'),
            ),
          ),
          h(
            'div',
            { className: 'dy-ov-host-kv' },
            h('span', null, t('ovHostCores')),
            h('b', null, system ? String(system.cpus ?? t('never')) : t('never')),
          ),
          h(
            'div',
            { className: 'dy-ov-host-kv' },
            h('span', null, t('ovHostUptime')),
            h('b', null, formatUptime(system ? (Number(system.uptime) || 0) * 1000 : 0, t)),
          ),
          h(
            'div',
            { className: 'dy-ov-host-kv' },
            h('span', null, t('ovHostPlatform')),
            h('b', null, system ? platformLabel(system.platform) : t('never')),
          ),
        ),
        h('p', { className: 'dy-ov-footnote' }, t('ovHostFootnote')),
      );
    }

    /**
     * @param {{ model: any, t: any }} props
     */
    function OverviewProjectLoadCard(props) {
      const { model, t } = props;
      const maxCpu = Math.max(...model.projects.map((project) => project.cpuPercent || 0), 1);
      const maxRss = Math.max(...model.projects.map((project) => project.rssBytes || 0), 1);
      return h(
        'div',
        { className: 'dy-ov-card' },
        h(OverviewCardHead, {
          title: t('ovProjectLoadTitle'),
          subtitle: t('ovProjectLoadSubtitle'),
          side: format(t('ovProjectLoadMeta'), {
            projects: model.projects.length,
            apps: model.apps.length,
          }),
        }),
        ...model.projects.map((project) =>
          h(
            'div',
            { key: project.id, className: 'dy-ov-project-row' },
            h(
              'div',
              { className: 'dy-ov-project-main' },
              h(
                'div',
                { className: 'dy-ov-project-line' },
                h('span', { className: 'dy-ov-project-name' }, project.name || t('unclassified')),
                project.root ? h('span', { className: 'dy-ov-project-path' }, project.root) : null,
                h(OverviewTags, {
                  languages: project.languages,
                  managers: project.managers,
                  t,
                }),
              ),
              h(
                'div',
                { className: 'dy-ov-project-bars' },
                h(
                  'span',
                  { className: 'dy-ov-mini-meter' },
                  h('i', {
                    style: {
                      width: `${clampPercent((project.cpuPercent / maxCpu) * 100)}%`,
                    },
                  }),
                ),
                h(
                  'span',
                  { className: 'dy-ov-mini-meter dy-ov-mini-meter-mem' },
                  h('i', {
                    style: {
                      width: `${clampPercent((project.rssBytes / maxRss) * 100)}%`,
                    },
                  }),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dy-ov-project-meta' },
              h('b', null, String(project.apps)),
              ` ${t('ovProjectApps').replace('{count}', '').trim()}`,
              h('br'),
              h('span', null, format(t('ovProjectRunning'), { count: project.running })),
            ),
            h(
              'div',
              { className: 'dy-ov-project-value' },
              project.running ? formatPercent(project.cpuPercent, t('never')) : t('never'),
              h('br'),
              h('span', null, project.running ? formatSizeDetailed(project.rssBytes) : t('never')),
            ),
          ),
        ),
      );
    }

    /**
     * @param {{ t: any, apps: any[], field: 'cpu' | 'mem', title: string, merged?: boolean, mode?: string, onModeChange?: (mode: string) => void }} props
     */
    function OverviewRankingCard(props) {
      const { t, apps, field } = props;
      const items = [...apps]
        .filter((app) => Number.isFinite(field === 'cpu' ? app.cpuPercent : app.rssBytes))
        .sort((a, b) =>
          field === 'cpu'
            ? (Number(b.cpuPercent) || 0) - (Number(a.cpuPercent) || 0)
            : (Number(b.rssBytes) || 0) - (Number(a.rssBytes) || 0),
        )
        .slice(0, 5);
      const max = Math.max(
        ...items.map((app) => Number(field === 'cpu' ? app.cpuPercent : app.rssBytes) || 0),
        1,
      );
      return h(
        'div',
        { className: 'dy-ov-card' },
        h(
          'div',
          { className: 'dy-ov-card-head' },
          h(
            'div',
            null,
            h('h3', { className: 'dy-ov-card-title' }, props.title),
            h('p', { className: 'dy-ov-card-sub' }, t('ovRankSubtitle')),
          ),
          props.merged
            ? h(
                'div',
                { className: 'dy-ov-seg', role: 'group', 'aria-label': t('ovRankingTitle') },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dy-ov-seg-btn',
                    'aria-pressed': props.mode === 'cpu',
                    onClick: () => props.onModeChange?.('cpu'),
                  },
                  t('ovRankCpu'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dy-ov-seg-btn',
                    'aria-pressed': props.mode === 'mem',
                    onClick: () => props.onModeChange?.('mem'),
                  },
                  t('ovResourceMemory'),
                ),
              )
            : h(
                'span',
                { className: 'dy-ov-card-side' },
                field === 'cpu' ? t('ovRankCpu') : t('ovRankRss'),
              ),
        ),
        items.length === 0
          ? h('p', { className: 'dy-ov-hint' }, t('noMetrics'))
          : h(
              'div',
              { className: 'dy-ov-rank-list' },
              ...items.map((app) =>
                h(
                  'div',
                  { key: app.id, className: 'dy-ov-rank-row' },
                  h(
                    'div',
                    { className: 'dy-ov-rank-top' },
                    h('span', { className: 'dy-ov-rank-name' }, app.name),
                    h(
                      'span',
                      { className: 'dy-ov-rank-project' },
                      app.projectName ?? t('unclassified'),
                    ),
                    h(
                      'span',
                      { className: 'dy-ov-rank-value' },
                      field === 'cpu'
                        ? formatPercent(app.cpuPercent, t('never'))
                        : formatSizeDetailed(app.rssBytes),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dy-ov-meter' },
                    h('i', {
                      style: {
                        width: `${clampPercent(
                          ((Number(field === 'cpu' ? app.cpuPercent : app.rssBytes) || 0) / max) *
                            100,
                        )}%`,
                        background: field === 'mem' ? 'var(--dy-cat-business)' : undefined,
                      },
                    }),
                  ),
                ),
              ),
            ),
        props.merged ? h('p', { className: 'dy-ov-footnote' }, t('ovRankFootnote')) : null,
      );
    }

    /**
     * @param {{ app: any, t: any }} props
     */
    function OverviewAttentionRow(props) {
      const { app, t } = props;
      return h(
        'div',
        { className: 'dy-ov-alert-row' },
        h(
          'span',
          {
            className: `dy-ov-alert-icon ${
              app.status === 'crashed' ? '' : 'dy-ov-alert-icon-warn'
            }`,
          },
          app.status === 'crashed' ? '!' : 'i',
        ),
        h(
          'div',
          { className: 'dy-ov-alert-main' },
          h(
            'div',
            { className: 'dy-ov-alert-title' },
            app.name,
            h(OverviewTags, {
              languages: app.language ? [app.language] : [],
              managers: app.manager && app.manager !== '—' ? [app.manager] : [],
              t,
            }),
          ),
          h(
            'div',
            { className: 'dy-ov-alert-meta' },
            `${app.projectName ?? t('unclassified')} · ${
              app.statusReason || app.reason || app.command || ''
            }`,
          ),
        ),
        h(StatusPill, { status: app.status, t }),
        h(
          'div',
          { className: 'dy-ov-row-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dy-btn dy-ov-btn',
              onClick: () => props.onLogs(app.id),
            },
            t('actionLogs'),
          ),
          h(
            'button',
            {
              type: 'button',
              className:
                app.status === 'crashed' ? 'dy-btn dy-btn-primary dy-ov-btn' : 'dy-btn dy-ov-btn',
              disabled: props.busy !== '',
              onClick: () => {
                if (app.status === 'crashed') props.onStart(app.id);
                else if (app.missing) props.onSync();
                else if (app.restartRequired) props.onRestart(app.id);
                else props.onStart(app.id);
              },
            },
            app.status === 'crashed'
              ? t('actionStart')
              : app.missing
                ? t('ovActionSync')
                : app.restartRequired
                  ? t('actionRestart')
                  : t('actionStart'),
          ),
        ),
      );
    }

    /**
     * @param {{ model: any, t: any, onLogs: any, onStart: any, onRestart: any, onSync: any, busy: string }} props
     */
    function OverviewAttentionSection(props) {
      const { model, t } = props;
      if (model.attention.length === 0) return null;
      return h(
        'section',
        { className: 'dy-ov-block' },
        h(OverviewBlockHead, {
          title: h(
            React.Fragment,
            null,
            t('ovAttentionTitle'),
            ' ',
            h('span', { className: 'dy-ov-count' }, String(model.attention.length)),
          ),
          hint: t('ovAttentionSubtitle'),
          meta: t('ovAttentionMeta'),
        }),
        h(
          'div',
          { className: 'dy-ov-card dy-ov-list-card' },
          ...model.attention.map((app) =>
            h(OverviewAttentionRow, {
              key: app.id,
              app,
              t,
              busy: props.busy,
              onLogs: props.onLogs,
              onStart: props.onStart,
              onRestart: props.onRestart,
              onSync: props.onSync,
            }),
          ),
        ),
      );
    }

    /**
     * @param {{ model: any, t: any, onLogs: any, compact?: boolean }} props
     */
    function OverviewRunningSection(props) {
      const { model, t } = props;
      const running = [...model.running].sort(
        (a, b) => (Number(b.uptimeMs) || 0) - (Number(a.uptimeMs) || 0),
      );
      return h(
        'section',
        { className: 'dy-ov-block' },
        h(OverviewBlockHead, {
          title: h(
            React.Fragment,
            null,
            t('runningTitle'),
            ' ',
            h('span', { className: 'dy-ov-count' }, String(running.length)),
          ),
          hint: t('ovRunningHint'),
          meta: t('ovRunningMeta'),
        }),
        h(
          'div',
          { className: 'dy-ov-card dy-ov-list-card' },
          running.length === 0
            ? h('p', { className: 'dy-ov-hint dy-ov-list-empty' }, t('runningEmpty'))
            : null,
          ...running.map((app) =>
            h(
              'div',
              { key: app.id, className: 'dy-ov-run-row' },
              h(
                'div',
                { className: 'dy-ov-run-main' },
                h(
                  'div',
                  { className: 'dy-ov-run-title' },
                  app.name,
                  h(OverviewTags, {
                    languages: app.language ? [app.language] : [],
                    managers: app.manager && app.manager !== '—' ? [app.manager] : [],
                    t,
                  }),
                ),
                h(
                  'div',
                  { className: 'dy-ov-run-meta' },
                  `${app.projectRoot ?? ''} · ${app.command ?? ''} ${
                    Array.isArray(app.args) ? app.args.join(' ') : ''
                  }`,
                ),
              ),
              h(StatusPill, { status: app.status, t }),
              h(
                'div',
                { className: 'dy-ov-run-stats' },
                h(
                  'div',
                  { className: 'dy-ov-run-stat' },
                  h('b', null, formatDurationDetailed(app.uptimeMs, t)),
                  h('span', null, t('ovDuration')),
                ),
                h(
                  'div',
                  { className: 'dy-ov-run-stat' },
                  h('b', null, formatPercent(app.cpuPercent, t('never'))),
                  h('span', null, t('ovResourceCpu')),
                ),
                h(
                  'div',
                  { className: 'dy-ov-run-stat' },
                  h('b', null, formatSizeDetailed(app.rssBytes)),
                  h('span', null, t('ovResourceMemory')),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dy-btn dy-ov-btn',
                  onClick: () => props.onLogs(app.id),
                },
                t('actionLogs'),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * @param {{ warnings: string[], t: any }} props
     */
    function OverviewWarnings(props) {
      if (!props.warnings.length) return null;
      return h(
        'section',
        { className: 'dy-ov-block' },
        h(
          'div',
          { className: 'dy-ov-card' },
          h('h2', { className: 'dy-ov-card-title' }, props.t('warningsTitle')),
          h(
            'ul',
            { className: 'dy-ov-warning-list' },
            ...props.warnings.map((warning, index) => h('li', { key: index }, warning)),
          ),
        ),
      );
    }

    /**
     * 指标版概览。
     * @param {{ model: any, t: any, status: any, busy: string, onDiscover: any, onLogs: any, onStart: any, onRestart: any, onSync: any }} props
     */
    function OverviewMetricsView(props) {
      const { model, t, status } = props;
      return h(
        'div',
        { className: 'dy-ov' },
        h(
          'section',
          { className: 'dy-ov-block' },
          h(OverviewBlockHead, {
            title: h(
              React.Fragment,
              null,
              t('ovSectionOverview'),
              ' ',
              h('span', { className: 'dy-ov-count' }, format(t('ovMetricCount'), { count: 12 })),
            ),
            hint: t('ovSectionOverviewHint'),
            meta: format(t('ovUpdatedAt'), { time: formatClock(model.generatedAt) }),
          }),
          h(OverviewMetricGroups, { model, t }),
        ),
        h(
          'section',
          { className: 'dy-ov-block' },
          h(OverviewBlockHead, {
            title: t('ovSectionDistribution'),
            hint: t('ovSectionDistributionHint'),
            meta: format(t('ovSectionDistributionMeta'), { count: model.apps.length }),
          }),
          h(
            'div',
            { className: 'dy-ov-grid dy-ov-grid-3' },
            h(OverviewStatusCard, { model, t }),
            h(OverviewLanguageCard, { model, t }),
            h(OverviewManagerCard, { model, t }),
          ),
          h(
            'div',
            { className: 'dy-ov-grid dy-ov-grid-tech' },
            h(OverviewTechCard, { model, t }),
            h(OverviewResourceTrendCard, { model, t }),
            h(OverviewHostCard, { model, t }),
          ),
        ),
        h(
          'section',
          { className: 'dy-ov-block' },
          h(OverviewBlockHead, {
            title: t('ovSectionLoad'),
            hint: t('ovSectionLoadHint'),
            meta: format(t('ovLoadMeta'), {
              cpu: formatPercent(model.totalCpu, t('never')),
              memory: formatSizeDetailed(model.totalRss),
            }),
          }),
          h(OverviewProjectLoadCard, { model, t }),
          h(
            'div',
            { className: 'dy-ov-grid dy-ov-grid-2' },
            h(OverviewRankingCard, {
              t,
              apps: model.running,
              field: 'cpu',
              title: t('ovRankCpuTitle'),
            }),
            h(OverviewRankingCard, {
              t,
              apps: model.running,
              field: 'mem',
              title: t('ovRankMemoryTitle'),
            }),
          ),
        ),
        h(OverviewAttentionSection, {
          model,
          t,
          busy: props.busy,
          onLogs: props.onLogs,
          onStart: props.onStart,
          onRestart: props.onRestart,
          onSync: props.onSync,
        }),
        h(OverviewRunningSection, {
          model,
          t,
          onLogs: props.onLogs,
        }),
        h(OverviewWarnings, { warnings: status.warnings ?? [], t }),
      );
    }

    /**
     * 健康版概览：一个 hero + 更紧凑的构成/资源/项目区块。
     * @param {{ model: any, t: any, status: any, busy: string, onLogs: any, onStart: any, onRestart: any, onSync: any }} props
     */
    function OverviewHealthView(props) {
      const { model, t, status } = props;
      const [rankMode, setRankMode] = React.useState('cpu');
      const total = model.apps.length || 1;
      const cpuValues = model.history.map((sample) => Number(sample.cpuPercent) || 0);
      const rssValues = model.history.map((sample) => Number(sample.rssBytes) || 0);
      return h(
        'div',
        { className: 'dy-ov' },
        h(
          'section',
          { className: 'dy-ov-card dy-ov-hero' },
          h(
            'div',
            null,
            h('div', { className: 'dy-ov-hero-kicker' }, t('ovHealthKicker')),
            h(
              'div',
              { className: 'dy-ov-hero-number' },
              h('b', null, String(model.running.length)),
              h('span', null, format(t('ovHealthAppsRunning'), { total: model.apps.length })),
            ),
            h(
              'div',
              { className: 'dy-ov-hero-chips' },
              h(
                'span',
                { className: 'dy-ov-chip success' },
                format(t('ovHealthRunRate'), {
                  percent: formatWholePercent((model.running.length / total) * 100, t('never')),
                }),
              ),
              h(
                'span',
                { className: 'dy-ov-chip error' },
                format(t('ovHealthCrashed'), { count: model.crashed.length }),
              ),
              h(
                'span',
                { className: 'dy-ov-chip warn' },
                format(t('ovHealthMissing'), { count: model.missing.length }),
              ),
              h(
                'span',
                { className: 'dy-ov-chip warn' },
                format(t('ovHealthRestart'), { count: model.restartRequired.length }),
              ),
            ),
            h(
              'div',
              { className: 'dy-ov-hero-kpis' },
              ...[
                [t('ovHealthProjects'), String(model.projects.length)],
                [t('ovHealthLanguages'), String(model.languageStats.length)],
                [t('ovHealthManagers'), String(model.managerKinds)],
                [t('ovHealthAvgUptime'), formatDurationDetailed(model.avgUptime, t)],
              ].map(([label, value]) =>
                h(
                  'div',
                  { key: label, className: 'dy-ov-hero-kpi' },
                  h('span', null, label),
                  h('b', null, value),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dy-ov-hero-donut' },
            h(OverviewDonut, {
              segments: [
                {
                  label: t('statusRunning'),
                  value: model.running.length,
                  color: 'var(--dsw-alias-state-success-primary, #2ea043)',
                },
                {
                  label: t('statusCrashed'),
                  value: model.crashed.length,
                  color: 'var(--dsw-alias-state-error-primary, #f85149)',
                },
                {
                  label: t('statusStopped'),
                  value: model.stopped.length,
                  color: 'var(--dsw-alias-state-idle-primary, #8b949e)',
                },
              ],
              centerValue: model.apps.length,
              centerLabel: t('ovLabelApps'),
              ariaLabel: `${t('statusRunning')} ${model.running.length}，${t('statusCrashed')} ${
                model.crashed.length
              }，${t('statusStopped')} ${model.stopped.length}`,
              size: 150,
            }),
          ),
          h(
            'div',
            { className: 'dy-ov-hero-res' },
            h(
              'div',
              { className: 'dy-ov-trend-head' },
              h('span', { className: 'dy-ov-trend-label' }, t('ovResourceCpu')),
              h('b', null, formatPercent(model.totalCpu, t('never'))),
              h(
                'span',
                { className: 'dy-ov-trend-peak' },
                format(t('ovResourcePeak'), {
                  value:
                    model.cpuPeak === null ? t('never') : formatPercent(model.cpuPeak, t('never')),
                }),
              ),
            ),
            h(OverviewSparkline, {
              values: cpuValues,
              color: 'var(--dy-cat-brand)',
              label: t('ovResourceTitle'),
              gradientId: 'dy-ov-hero-spark-cpu',
              emptyText: t('ovResourceEmpty'),
            }),
            h(
              'div',
              { className: 'dy-ov-trend-head' },
              h('span', { className: 'dy-ov-trend-label' }, t('ovResourceMemory')),
              h('b', null, formatSizeDetailed(model.totalRss)),
              h(
                'span',
                { className: 'dy-ov-trend-peak' },
                format(t('ovResourcePeak'), {
                  value: model.rssPeak === null ? t('never') : formatSizeDetailed(model.rssPeak),
                }),
              ),
            ),
            h(OverviewSparkline, {
              values: rssValues,
              color: 'var(--dy-cat-business)',
              label: t('ovResourceMemory'),
              gradientId: 'dy-ov-hero-spark-rss',
              emptyText: t('ovResourceEmpty'),
            }),
          ),
        ),
        h(
          'section',
          { className: 'dy-ov-block' },
          h(OverviewBlockHead, {
            title: t('ovHealthTechSection'),
            hint: t('ovHealthTechSectionHint'),
            meta: format(t('ovHealthTechMeta'), { count: model.ecoStats.length }),
          }),
          h(
            'div',
            { className: 'dy-ov-grid dy-ov-grid-3' },
            h(OverviewLanguageCard, { model, t }),
            h(OverviewManagerCard, { model, t }),
            h(OverviewTechCard, { model, t }),
          ),
        ),
        h(
          'section',
          { className: 'dy-ov-block' },
          h(OverviewBlockHead, {
            title: t('ovHealthResourcesSection'),
            hint: t('ovHealthResourcesHint'),
            meta: t('ovHealthResourcesMeta'),
          }),
          h(
            'div',
            { className: 'dy-ov-grid dy-ov-grid-health' },
            h(OverviewResourceTrendCard, { model, t, gradientPrefix: 'dy-ov-health' }),
            h(OverviewHostCard, { model, t }),
            h(
              'div',
              { className: 'dy-ov-card' },
              h(OverviewCardHead, {
                title: h(
                  React.Fragment,
                  null,
                  t('ovAttentionTitle'),
                  ' ',
                  h('span', { className: 'dy-ov-count' }, String(model.attention.length)),
                ),
                subtitle: t('ovAttentionSubtitle'),
                side: t('ovAttentionMeta'),
              }),
              model.attention.length === 0
                ? h('p', { className: 'dy-ov-hint' }, t('attentionEmpty'))
                : h(
                    'div',
                    { className: 'dy-ov-compact-alerts' },
                    ...model.attention.map((app) =>
                      h(
                        'div',
                        { key: app.id, className: 'dy-ov-compact-alert' },
                        h(
                          'span',
                          {
                            className: `dy-ov-alert-icon ${
                              app.status === 'crashed' ? '' : 'dy-ov-alert-icon-warn'
                            }`,
                          },
                          app.status === 'crashed' ? '!' : 'i',
                        ),
                        h(
                          'div',
                          { className: 'dy-ov-alert-main' },
                          h('div', { className: 'dy-ov-alert-title' }, app.name),
                          h(
                            'div',
                            { className: 'dy-ov-alert-meta' },
                            app.statusReason || app.reason || app.command || '',
                          ),
                        ),
                        h(StatusPill, { status: app.status, t }),
                      ),
                    ),
                  ),
              h('p', { className: 'dy-ov-footnote' }, t('ovAttentionFoot')),
            ),
          ),
        ),
        h(
          'section',
          { className: 'dy-ov-block' },
          h(OverviewBlockHead, {
            title: t('ovHealthProjectSection'),
            hint: t('ovHealthProjectHint'),
            meta: format(t('ovLoadMeta'), {
              cpu: formatPercent(model.totalCpu, t('never')),
              memory: formatSizeDetailed(model.totalRss),
            }),
          }),
          h(
            'div',
            { className: 'dy-ov-grid dy-ov-grid-project' },
            h(OverviewProjectLoadCard, { model, t }),
            h(OverviewRankingCard, {
              t,
              apps: model.running,
              field: rankMode,
              title: t('ovRankingTitle'),
              merged: true,
              mode: rankMode,
              onModeChange: setRankMode,
            }),
          ),
        ),
        h(OverviewRunningSection, {
          model,
          t,
          onLogs: props.onLogs,
        }),
        h(OverviewWarnings, { warnings: status.warnings ?? [], t }),
      );
    }

    /**
     * 概览：指标版与健康版共用同一个入口，按 mode 分发。
     * 现有的加载、错误与空状态保持不变。
     * @param {{ status: any, t: any, mode?: 'metrics' | 'health', busy: string, onDiscover: any, onLogs: any, onStart: any, onRestart: any, onSync: any }} props
     */
    function OverviewView(props) {
      const { status, t, mode = 'metrics' } = props;
      const apps = Array.isArray(status.applications) ? status.applications : [];
      if (status.phase === 'loading' && apps.length === 0) {
        return h(EmptyState, { title: t('loading') });
      }
      if (status.phase === 'error' && apps.length === 0) {
        return h(EmptyState, {
          title: t('unavailable'),
          hint: `${t('unavailableHint')}：${status.error}`,
        });
      }
      if (apps.length === 0) {
        return h(EmptyState, {
          title: t('emptyTitle'),
          hint: t('emptyHint'),
          action: h(
            'button',
            { type: 'button', className: 'dy-btn dy-btn-primary', onClick: props.onDiscover },
            t('emptyAction'),
          ),
        });
      }
      const model = buildOverviewModel(status);
      return mode === 'health'
        ? h(OverviewHealthView, { ...props, model })
        : h(OverviewMetricsView, { ...props, model });
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
        onTakeoverAll,
        onTakeoverProject,
        onTakeoverApp,
        externalUnmatched,
        externalError,
      } = props;
      const apps = status.applications;
      /** 托管应用 + 能匹配回应用的外部进程，合成同一条应用列表。 */
      const managedApps = apps.map((app) => ({ ...app, managed: true }));
      const externalApps = (status.externalApps ?? []).map((app) => ({ ...app, managed: false }));
      const appById = new Map(managedApps.map((app) => [app.id, app]));
      for (const app of externalApps) appById.set(app.id, app);
      const allApps = [...appById.values()];

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
      for (const app of allApps) {
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
        const managed = app.managed !== false;
        const running = isActive(app);
        const removeOpen = managed && confirmRemove === app.id;
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
              h(
                'span',
                {
                  className: `dy-badge ${managed ? 'dy-badge-ok' : 'dy-badge-warn'}`,
                  title: managed ? t('managedBadge') : t('externalAppsHint'),
                },
                managed ? t('managedBadge') : t('unmanagedBadge'),
              ),
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
              !managed && Array.isArray(app.ports) && app.ports.length > 0
                ? h(
                    React.Fragment,
                    null,
                    h('span', { className: 'dy-svc-row-sep' }, '·'),
                    h(
                      'span',
                      { className: 'dy-mono' },
                      format(t('externalPorts'), { ports: app.ports.join(', ') }),
                    ),
                  )
                : null,
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
            managed && app.statusReason && app.status !== 'stopped'
              ? h('div', { className: 'dy-service-reason' }, app.statusReason)
              : null,
          ),
          h(
            'div',
            { className: 'dy-svc-row-status' },
            managed
              ? h(StatusPill, { status: app.status, t })
              : h(
                  'span',
                  { className: 'dy-pill', 'data-status': 'running' },
                  h('span', { className: 'dy-dot' }),
                  h('span', { className: 'dy-pill-label' }, t('externalRunning')),
                ),
            /** 没在跑就没有时长可显示，不要用一排"—"占位。 */
            typeof app.uptimeMs === 'number'
              ? h('span', { className: 'dy-svc-uptime' }, formatUptime(app.uptimeMs, t))
              : null,
          ),
          h(
            'div',
            { className: 'dy-svc-row-actions' },
            !managed
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dy-btn dy-btn-primary',
                      disabled: busy !== '',
                      title: t('externalAppsHint'),
                      onClick: () => onTakeoverApp(app.id),
                    },
                    t('takeoverApp'),
                  ),
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
                      title: t('externalRestartHint'),
                      onClick: () => act('restart', { id: app.id }, `restart:${app.id}`),
                    },
                    t('actionRestart'),
                  ),
                )
              : h(
                  React.Fragment,
                  null,
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
          ),
        );
      }

      /** 语言筛选项来自全部应用（含外部启动）的真实语言，去重排序。 */
      const languages = [
        ...new Set(
          allApps.flatMap((app) =>
            typeof app.language === 'string' && app.language !== '' ? [app.language] : [],
          ),
        ),
      ].sort((a, b) => a.localeCompare(b));

      const countByFilter = {
        all: allApps.length,
        running: 0,
        crashed: 0,
        stopped: 0,
        unmanaged: 0,
      };
      for (const app of allApps) {
        if (app.managed === false) countByFilter.unmanaged += 1;
        else if (isActive(app)) countByFilter.running += 1;
        else if (app.status === 'crashed' || app.status === 'unknown') countByFilter.crashed += 1;
        else countByFilter.stopped += 1;
      }

      const matchesStatus = (app) => {
        if (statusFilter === 'all') return true;
        if (statusFilter === 'unmanaged') return app.managed === false;
        if (app.managed === false) return false;
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
          ...(Array.isArray(app.ports) ? app.ports.map(String) : []),
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
        ['unmanaged', 'filterUnmanaged'],
      ];

      const syncText = sync
        ? `${new Date(sync.at).toLocaleTimeString()} · ${format(t('syncSummary'), {
            added: sync.added,
            changed: sync.changed,
            missing: sync.missing,
          })}`
        : t('syncNever');

      const externalTotal = allApps.filter((app) => app.managed === false).length;

      return h(
        'div',
        { className: 'dy-svc-page' },
        h(
          'div',
          { className: 'dy-sync-bar' },
          h('span', { className: 'dy-hint' }, syncText),
          externalError
            ? h('span', { className: 'dy-badge dy-badge-danger' }, externalError)
            : null,
          externalUnmatched > 0
            ? h(
                'span',
                { className: 'dy-badge dy-badge-warn', title: t('externalAppsHint') },
                format(t('externalUnmatchedCount'), { count: externalUnmatched }),
              )
            : null,
          h('span', { className: 'dy-spacer' }),
          externalTotal > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dy-btn dy-btn-primary',
                  disabled: busy !== '',
                  onClick: onTakeoverAll,
                },
                format(t('takeoverAllCount'), { count: externalTotal }),
              )
            : null,
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
                const externalCount = group.apps.filter((app) => app.managed === false).length;
                const startable = group.apps.filter(
                  (app) => app.managed !== false && !isActive(app) && !app.missing,
                );
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
                        externalCount > 0
                          ? h(
                              'span',
                              { className: 'dy-badge dy-badge-warn' },
                              `${t('unmanagedBadge')} ${externalCount}`,
                            )
                          : null,
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
                      externalCount > 0
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'dy-btn dy-btn-primary',
                              disabled: busy !== '',
                              onClick: () => onTakeoverProject(group.key),
                            },
                            format(t('takeoverAllCount'), { count: externalCount }),
                          )
                        : null,
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
      const { t, project, busy, selected, onToggleSelected, onHostProject } = props;
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
      } = props;

      const projects = scan && Array.isArray(scan.projects) ? scan.projects : [];
      const apps = projects.flatMap((project) =>
        (project.ecosystems ?? []).flatMap((group) => group.apps ?? []),
      );
      const projectsWithApps = projects.filter((project) => (project.ecosystems ?? []).length > 0);
      const projectsWithoutApps = projects.filter(
        (project) => (project.ecosystems ?? []).length === 0,
      );
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
      const [tab, setTab] = React.useState('overviewMetrics');
      const [status, setStatus] = React.useState({
        phase: 'loading',
        generatedAt: Date.now(),
        applications: [],
        externalApps: [],
        externalUnmatched: 0,
        externalError: '',
        projects: [],
        system: null,
        resourceHistory: [],
        preferences: { statusBar: readStatusBarCache() },
        sync: null,
        syncIntervalMs: 0,
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

      const scanFromRoots = React.useCallback(async (roots) => {
        setScanning(true);
        setNotice(null);
        try {
          const result = await postAction('scan', { roots });
          setScan({ ...result, roots });
        } catch (error) {
          setNotice({ kind: 'error', text: messageOf(error) });
        } finally {
          setScanning(false);
        }
      }, []);

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
        ['overviewMetrics', 'tabOverviewMetrics'],
        ['overviewHealth', 'tabOverviewHealth'],
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
          act,
          sync: status.sync,
          syncIntervalMs: status.syncIntervalMs,
          onSync: onSyncNow,
          onTakeoverAll: () => act('takeover-all', {}, 'takeover-all'),
          onTakeoverProject: (projectId) =>
            act('takeover-project', { projectId }, `takeover-project:${projectId}`),
          onTakeoverApp: (id) => act('takeover-app', { id }, `takeover:${id}`),
          externalUnmatched: status.externalUnmatched,
          externalError: status.externalError,
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
          mode: tab === 'overviewHealth' ? 'health' : 'metrics',
          busy,
          onDiscover: () => setTab('discover'),
          onLogs: openLogs,
          onStart: (id) => act('start', { id }, `start:${id}`),
          onRestart: (id) => act('restart', { id }, `restart:${id}`),
          onSync: onSyncNow,
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
              h(
                'p',
                { className: 'dy-subtitle' },
                `${t('pageSubtitle')} · ${
                  status.sync?.at
                    ? format(t('lastSyncAt'), { time: formatClock(status.sync.at) })
                    : t('syncNever')
                }`,
              ),
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
                  disabled: busy !== '',
                  onClick: () => void onSyncNow(),
                },
                busy === 'sync' ? t('syncing') : t('syncNow'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dy-btn dy-btn-primary',
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
      const stoppedCount = apps.filter((app) => app.status === 'stopped').length;
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

      const ecoTags = shownEcosystems.map((group, index) =>
        h(
          'span',
          {
            key: group.key,
            // 第二组在窄容器里会被 CSS 隐藏；+N 另有一份只覆盖"第一组之外"的计数。
            className: index === 0 ? 'dy-tag-eco' : 'dy-tag-eco dy-tag-eco-secondary',
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
            {
              key: 'dock-eco-more-wide',
              className: 'dy-tag-eco dy-tag-eco-more dy-tag-eco-more-wide',
              title: ecoTitle,
            },
            `+${hiddenEcosystems}`,
          ),
        );
      }
      if (ecosystems.length > 1) {
        ecoTags.push(
          h(
            'span',
            {
              key: 'dock-eco-more-narrow',
              className: 'dy-tag-eco dy-tag-eco-more dy-tag-eco-more-narrow',
              title: ecoTitle,
            },
            `+${ecosystems.length - 1}`,
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
          h('span', { className: 'dy-gap' }, h('span', { className: 'dy-bar-sep' })),
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
            stoppedCount > 0
              ? h(
                  'span',
                  { className: 'dy-chip dy-chip-stopped', 'data-tone': 'neutral' },
                  h('span', { className: 'dy-chip-dot', 'aria-hidden': true }),
                  h('span', null, `${stoppedCount} ${t('dockStopped')}`),
                )
              : null,
            errorPhase ? chip('error', t('dockUnavailable'), state.error) : null,
          ),
          h('span', { className: 'dy-gap' }, h('span', { className: 'dy-bar-sep' })),
          h(
            'span',
            { className: 'dy-bar-chunk dy-bar-scale' },
            metric(projectCount, t('dockProjects')),
          ),
          h('span', { className: 'dy-gap' }, h('span', { className: 'dy-bar-sep' })),
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
          h('span', { className: 'dy-gap' }, h('span', { className: 'dy-bar-sep' })),
          h(
            'span',
            { className: 'dy-bar-chunk dy-bar-eco', title: ecoTitle },
            h('span', { className: 'dy-eco-label' }, t('dockEcosystems')),
            ...ecoTags,
          ),
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
