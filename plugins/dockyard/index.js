/**
 * dockyard 的 Host 半侧入口。
 *
 * 这一层只做适配：把宿主能力（工具注册表、数据目录、可选的 HTTP 路由）
 * 接到 src/service.js 的编排逻辑上。真正的行为都在 src/ 里，可脱离宿主测试。
 *
 * 数据流向：local-only。本插件不发起任何出网请求；日志与状态只写在本机数据目录。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from './src/internal/config.js';
import { defineTool } from './src/internal/tool-definition.js';
import {
  ACTION_ROUTE,
  EXTERNAL_ROUTE,
  LOGS_ROUTE,
  STATUS_ROUTE,
  createDockyardHandlers,
} from './src/http.js';
import { DockyardService } from './src/service.js';
import { DOCKYARD_SKILL } from './skill/index.js';

/** 稳定的 Loader 标识。 */
export const name = 'dockyard';

/** 本插件需要的宿主服务。`webServer` 是可选能力，缺少时面板降级为不可用。 */
export const inject = ['tools'];

/**
 * 插件配置的规格表。用户在 profile 的 cordis.patch.yml 里覆盖这些字段；
 * 那份 patch 层能挺过插件升级，所以可调参数都应该放在这里。
 *
 * **为什么不是 schemastery 的 `Config`。** 声明 `Config` 需要 import 宿主自带的
 * schemastery；一旦写成依赖，pnpm 会在 profile 里装出第二份宿主包，遮住宿主自带的
 * 版本——宿主升级后精确版本校验失败，`tools` 行被禁用，所有工具类插件一起失效。
 * 配置校验不是激活的必要条件，因此用规格表自行归一化，不合法就回退默认值并记诊断。
 *
 * @type {Record<string, import('./src/internal/config.js').ConfigField>}
 */
const CONFIG_SPEC = {
  dataDir: { type: 'string' },
  gracefulTimeoutMs: { type: 'number', default: 5000 },
  killTimeoutMs: { type: 'number', default: 3000 },
  stopProcessesOnUnload: { type: 'boolean', default: false },
  enablePanelRoute: { type: 'boolean', default: true },
  enableSkill: { type: 'boolean', default: true },
  syncIntervalMs: { type: 'number', default: 300000 },
  syncOnStart: { type: 'boolean', default: true },
};

/**
 * 安全地记录一条警告。
 *
 * 刻意不用 ctx.logger：那是服务属性，未声明 inject 时读取会抛异常，
 * 而为了写一条警告去 inject logger 并不划算。用 ctx.get 探测式读取即可，
 * 取不到时退回 console——日志不该成为插件激活失败的原因。
 *
 * @param {any} ctx
 * @param {string} message
 */
function warn(ctx, message) {
  const logger = typeof ctx.get === 'function' ? ctx.get('logger', false) : undefined;
  if (logger && typeof logger.warn === 'function') {
    logger.warn(message);
    return;
  }
  console.warn(message);
}

/**
 * 把字节数渲染成紧凑单位。
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
 * 推导插件数据目录。
 *
 * 刻意不依赖 ctx 上的宿主路径服务：那些服务需要声明 inject 才能读，
 * 而它们在不同宿主组合里未必存在。这里只用环境变量与家目录，
 * 让插件在任意组合下都能算出一个确定的位置。
 *
 * @param {string | undefined} configured 用户在 Config 里指定的目录
 * @returns {string}
 */
export function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured;
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.trim() !== '') {
    return join(home, 'plugin-data', 'dockyard');
  }
  return join(homedir(), '.dsh-plugin-data', 'dockyard');
}

/**
 * 注册 Host 半侧。
 *
 * @param {any} ctx Cordis 上下文
 * @param {any} rawConfig profile patch 里的原始 config
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(CONFIG_SPEC, rawConfig, (message) => warn(ctx, message));
  const dataDir = resolveDataDir(config.dataDir);

  const service = new DockyardService({
    dataDir,
    onWarn: (message) => warn(ctx, `[dockyard] ${message}`),
    syncIntervalMs: config.syncIntervalMs,
    syncOnStart: config.syncOnStart,
  });

  // 服务初始化放在 effect 里：加载状态、建目录都属于"本次挂载拥有的资源"。
  ctx.effect(() => {
    let disposed = false;
    void service.init().catch((error) => {
      ctx.logger?.warn?.(
        `[dockyard] 状态加载失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return async () => {
      if (disposed) return;
      disposed = true;
      // 默认保留进程，但把无法确认的状态如实记下来，避免下次读到"运行中"的谎言。
      const result = await service.shutdown({ killProcesses: config.stopProcessesOnUnload });
      if (result.leftRunning > 0) {
        warn(
          ctx,
          `[dockyard] 卸载时有 ${result.leftRunning} 个被托管的进程仍在运行，其状态已标记为 unknown。`,
        );
      }
    };
  });

  const stopOptions = {
    gracefulTimeoutMs: config.gracefulTimeoutMs,
    killTimeoutMs: config.killTimeoutMs,
  };
  service.stopOptions = stopOptions;

  ctx.tools.register(
    defineTool({
      name: 'dockyard_status',
      description:
        '列出本机被 dockyard 托管的开发服务及其真实状态。状态以实际探测为准：进程若已消失，会在此更正为 crashed。',
      parameters: {},
      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
              status: { type: 'string', required: true },
              statusReason: { type: 'string', required: true },
              dir: { type: 'string', required: true },
              command: { type: 'string', required: true },
              projectName: { type: 'string' },
              projectRoot: { type: 'string' },
              missing: { type: 'boolean' },
              restartRequired: { type: 'boolean' },
              lastSeenAt: { type: 'integer' },
              ecosystemName: { type: 'string' },
              language: { type: 'string' },
              manager: { type: 'string' },
              pid: { type: 'integer' },
              uptimeMs: { type: 'integer' },
            },
          },
        },
        /**
         * @param {any} _args
         * @param {any[]} value
         */
        render: (_args, value) => {
          if (value.length === 0) return [{ type: 'text', text: 'dockyard 还没有托管任何应用。' }];
          const lines = value.map((/** @type {any} */ item) => {
            const project = item.projectName ? `${item.projectName} / ` : '';
            const ecosystem = item.ecosystemName ? ` (${item.ecosystemName})` : '';
            const flags = `${item.missing ? ' [失联]' : ''}${item.restartRequired ? ' [需重启]' : ''}`;
            return (
              `${project}${item.name}${ecosystem} [${item.status}]${flags} ${item.command} ${item.dir}` +
              (item.pid ? ` (pid ${item.pid})` : '') +
              (item.statusReason ? ` — ${item.statusReason}` : '')
            );
          });
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute() {
        return service.list();
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_scan',
      description:
        '扫描一个目录，把它归一化成“项目 → 语言生态分组 → 可运行应用”：优先按 git 识别项目，支持 Java Maven、Node.js（pnpm/yarn/npm/bun）、PHP Composer、Flutter、Go、Rust、Python 等生态，并给出每个应用的判定理由。不写入任何内容。',
      parameters: {
        roots: {
          type: 'array',
          required: true,
          description: '要扫描的根目录绝对路径列表。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scannedDirs: { type: 'integer', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const result = await service.scan(args.roots);
        const lines = [];
        let appCount = 0;
        for (const project of result.projects) {
          const container = project.container ? `${project.container.name} / ` : '';
          const source = project.source === 'git' ? 'git' : '无 git';
          lines.push(
            `${container}${project.name}（${source}）— ${project.root}\n  项目 id：${project.id}`,
          );
          for (const group of project.ecosystems) {
            lines.push(`  ${group.name}`);
            for (const app of group.apps) {
              appCount += 1;
              lines.push(
                `    ${app.alreadyAdded ? '[已托管] ' : ''}${app.name} — ${app.command} ${app.args.join(' ')}\n` +
                  `      应用 id：${app.id}\n      目录：${app.dir}\n      理由：${app.reason}`,
              );
            }
          }
          for (const diagnostic of project.diagnostics.slice(0, 5)) {
            lines.push(`  ! ${diagnostic.message}`);
          }
        }
        if (result.diagnostics.length > 0) {
          lines.push(
            `\n注意：有 ${result.diagnostics.length} 处内容被跳过或修正：\n` +
              result.diagnostics
                .slice(0, 20)
                .map((d) => `  ${d.path} — ${d.message}`)
                .join('\n'),
          );
        }
        return {
          scannedDirs: result.scannedDirs,
          summary:
            `扫描了 ${result.scannedDirs} 个目录，识别出 ${result.projects.length} 个项目、${appCount} 个可运行应用。\n` +
            (lines.length > 0 ? lines.join('\n') : '（没有发现可运行的应用）'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_add',
      description:
        '把一个项目加入 dockyard 托管列表（项目级托管：项目下全部可运行应用一起加入）。优先传 projectId；candidateId 是只加单个应用的后门。必须先扫描取得 id，不要凭猜测构造。',
      parameters: {
        projectId: {
          type: 'string',
          description: 'dockyard_scan 返回的项目 id（推荐）。',
        },
        candidateId: {
          type: 'string',
          description: 'dockyard_scan 返回的单个应用 id（可选后门）。',
        },
        roots: {
          type: 'array',
          required: true,
          description: '与扫描时相同的根目录，用于重新确认项目仍然存在。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            added: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.reason }],
      },
      async execute(args) {
        // 重新扫描一次而不是从调用方取值：项目/应用定义以当前磁盘事实为准。
        if (args.projectId) {
          const result = await service.addProjectsFromScan([args.projectId], args.roots);
          return { added: result.added, reason: result.reason };
        }
        if (args.candidateId) {
          return service.addFromScan(args.candidateId, args.roots);
        }
        return { added: false, reason: '需要 projectId（项目级托管）或 candidateId（单个应用）。' };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_start',
      description:
        '启动一个被托管的开发服务。进程归 dockyard 所有，发起调用的客户端断开后仍然存活。',
      parameters: {
        id: { type: 'string', required: true, description: 'dockyard_status 返回的应用 id。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            started: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
            pid: { type: 'integer' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.reason }],
      },
      async execute(args) {
        return service.start(args.id);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_stop',
      description:
        '停止一个被托管的开发服务：先发温和终止信号，超时后升级为强杀，并等到进程真的消失才返回。',
      parameters: {
        id: { type: 'string', required: true, description: 'dockyard_status 返回的应用 id。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stopped: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.reason }],
      },
      async execute(args) {
        return service.stop(args.id);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_restart',
      description:
        '重启一个被托管的开发服务：先停止（等进程真的消失），再用原来的参数启动。修改代码或配置后需要重新加载时使用。',
      parameters: {
        id: { type: 'string', required: true, description: 'dockyard_status 返回的应用 id。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            restarted: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.reason }],
      },
      async execute(args) {
        return service.restart(args.id);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_logs',
      description: '读取一个被托管的开发服务最近的日志。stdout 标为 OUT，stderr 标为 ERR。',
      parameters: {
        id: { type: 'string', required: true, description: 'dockyard_status 返回的应用 id。' },
        lines: { type: 'integer', description: '读取的行数，默认 100，上限 2000。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const requested = Number.isInteger(args.lines)
          ? Math.min(2000, Math.max(1, args.lines))
          : 100;
        const result = await service.logs(args.id, requested);
        if (result.lines.length === 0) {
          return { source: 'none', text: '该应用还没有产生日志。' };
        }
        const origin =
          result.source === 'buffer'
            ? '内存缓冲'
            : result.source === 'file'
              ? '日志文件尾部'
              : '无';
        return { source: result.source, text: `（来源：${origin}）\n${result.lines.join('\n')}` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_projects',
      description:
        '按项目汇总当前托管的开发服务：项目下应用数、运行中数量、CPU 与内存合计。排查“哪个项目在吃资源”时先看它。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute() {
        const projects = await service.listProjects();
        if (projects.length === 0) return { summary: 'dockyard 还没有托管任何项目。' };
        const lines = projects.map(
          (project) =>
            `${project.name} — ${project.running}/${project.apps} 运行${
              project.missing > 0 ? `，${project.missing} 失联` : ''
            }${project.restartRequired > 0 ? `，${project.restartRequired} 需重启` : ''}，CPU ${project.cpuPercent.toFixed(
              1,
            )}%，内存 ${formatBytes(project.rssBytes)}`,
        );
        return { summary: lines.join('\n') };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_metrics',
      description:
        '读取托管应用的 CPU/内存采样。传 id 看单个应用的历史摘要；不传则按项目汇总。CPU 为进程组采样值（可能超过 100%，多核），内存 RSS 会重复计算共享页，属于上界估计。',
      parameters: {
        id: { type: 'string', description: '应用 id；省略时按项目汇总。' },
        lines: { type: 'integer', description: '历史采样条数，默认 60，上限 288。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        if (args.id) {
          const requested = Number.isInteger(args.lines)
            ? Math.min(288, Math.max(1, args.lines))
            : 60;
          const result = await service.getMetrics(args.id, requested);
          if (result.samples.length === 0) {
            return { summary: '该应用还没有 CPU/内存采样。' };
          }
          const sample = result.samples.at(-1);
          const cpuValues = result.samples.map((item) => item.cpuPercent);
          const rssValues = result.samples.map((item) => item.rssBytes);
          const avgCpu = cpuValues.reduce((sum, value) => sum + value, 0) / cpuValues.length;
          const maxCpu = Math.max(...cpuValues);
          const maxRss = Math.max(...rssValues);
          const lines = result.samples
            .slice(-10)
            .map(
              (item) =>
                `${new Date(item.at).toISOString().slice(11, 19)}  CPU ${item.cpuPercent.toFixed(
                  1,
                )}%  内存 ${formatBytes(item.rssBytes)}`,
            );
          return {
            summary:
              `最近采样：CPU ${sample?.cpuPercent.toFixed(1)}%，内存 ${formatBytes(
                sample?.rssBytes,
              )}（${result.source === 'memory' ? '内存' : '文件'}，${result.samples.length} 条）\n` +
              `平均 CPU ${avgCpu.toFixed(1)}%，峰值 CPU ${maxCpu.toFixed(1)}%，峰值内存 ${formatBytes(
                maxRss,
              )}\n` +
              lines.join('\n'),
          };
        }
        const projects = await service.listProjects();
        if (projects.length === 0) return { summary: 'dockyard 还没有托管任何项目。' };
        return {
          summary: projects
            .map(
              (project) =>
                `${project.name} — CPU ${project.cpuPercent.toFixed(1)}%，内存 ${formatBytes(
                  project.rssBytes,
                )}（${project.running}/${project.apps} 运行）`,
            )
            .join('\n'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_diagnose',
      description:
        '调试一个托管应用的组合视图：当前状态与原因、最近 CPU/内存采样、最近 40 行日志。程序崩溃、端口冲突、CPU/内存异常时先用它，再决定 restart 或看完整日志。',
      parameters: {
        id: { type: 'string', required: true, description: '应用 id。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const apps = await service.list();
        const app = apps.find((item) => item.id === args.id);
        if (!app) return { summary: `没有 id 为 ${args.id} 的托管应用。` };
        const metrics = await service.getMetrics(args.id, 30);
        const logs = await service.logs(args.id, 40);
        const latest = metrics.samples.at(-1);
        return {
          summary:
            `${app.projectName ? `${app.projectName} / ` : ''}${app.name} [${app.status}]\n` +
            `状态原因：${app.statusReason || '（无）'}\n` +
            `命令：${app.command} ${app.args.join(' ')}  目录：${app.dir}\n` +
            `资源：CPU ${latest ? `${latest.cpuPercent.toFixed(1)}%` : '无采样'}，内存 ${
              latest ? formatBytes(latest.rssBytes) : '无采样'
            }\n` +
            `--- 最近日志 ---\n${logs.lines.length > 0 ? logs.lines.join('\n') : '（无日志）'}`,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_external',
      description:
        '列出 cwd 在项目根目录下、但不是 dockyard 启动的外部进程，带 pid、命令、CPU/内存与监听端口。用于发现“终端里手动起的服务”。',
      parameters: {
        roots: {
          type: 'array',
          description: '项目根目录；省略时使用已托管项目的根目录。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const result = await service.externalProcesses(args.roots);
        if (result.error) return { summary: `外部进程发现失败：${result.error}` };
        if (result.processes.length === 0) return { summary: '没有发现外部启动的项目进程。' };
        return {
          summary: result.processes
            .map(
              (item) =>
                `pid ${item.pid} [${item.root}] CPU ${item.cpuPercent.toFixed(1)}% 内存 ${formatBytes(
                  item.rssBytes,
                )} 端口 ${item.ports.length > 0 ? item.ports.join(',') : '—'}\n  ${item.command}`,
            )
            .join('\n'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_takeover',
      description:
        '接管一个被外部启动的项目：先终止 cwd 在项目根下的外部进程，再按项目重新托管并启动全部应用。会先重新扫描磁盘确认项目和命令。',
      parameters: {
        projectId: { type: 'string', required: true, description: 'dockyard_scan 返回的项目 id。' },
        roots: {
          type: 'array',
          required: true,
          description: '与扫描时相同的根目录。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            takenOver: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.reason }],
      },
      async execute(args) {
        const result = await service.takeoverProjectFromScan(args.projectId);
        return { takenOver: result.takenOver, reason: result.reason };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_sync',
      description:
        '立即按磁盘事实同步已托管项目：新增应用加入托管（不自动启动），启动命令变化保留旧参数并标记需重启，磁盘上消失的应用标记失联但不删除。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute() {
        const result = await service.syncProjects();
        return {
          summary:
            `同步了 ${result.projects} 个项目（${result.durationMs}ms）：新增 ${result.added}，` +
            `命令变化 ${result.changed}，失联 ${result.missing}，恢复 ${result.reappeared}，错误 ${result.errors}。`,
        };
      },
    }),
  );

  // 技能：把“什么时候该用 dockyard 调试服务”的方法论带进会话技能目录。
  // skills 是可选服务，缺失时只记警告，工具本身照常可用。
  if (config.enableSkill) {
    const skills = typeof ctx.get === 'function' ? ctx.get('skills', false) : undefined;
    if (skills === undefined) {
      warn(ctx, '缺少 skills 服务，dockyard 方法论技能没有注册；工具本身照常可用。');
    } else {
      ctx.effect(() => {
        try {
          const dispose = skills.register({
            name: DOCKYARD_SKILL.name,
            description: DOCKYARD_SKILL.description,
            whenToUse: DOCKYARD_SKILL.whenToUse,
            content: DOCKYARD_SKILL.content,
            source: 'plugin:dockyard',
            invocation: { modelInvocable: true, userInvocable: true },
          });
          return () => dispose();
        } catch (error) {
          warn(ctx, `注册技能失败：${error instanceof Error ? error.message : String(error)}`);
          return () => {};
        }
      });
    }
  }

  // 面板 HTTP 通道：状态、日志与动作三条 exact 路由。
  //
  // webServer 是可选服务：不声明 inject 就直接读 ctx.webServer 会抛异常，
  // 而声明成静态 inject 又会让插件在没有 HTTP 服务的组合里完全不激活。
  // 正确做法是 scoped inject——宿主在服务可用时才运行这段代码，
  // 服务不存在时插件其余部分照常工作。
  if (config.enablePanelRoute) {
    const handlers = createDockyardHandlers(service);

    /**
     * 把三条路由注册到宿主 webServer 上。
     * @param {any} webCtx 带 webServer 的子上下文
     */
    const registerPanelRoutes = (webCtx) => {
      webCtx.effect(() => {
        const disposers = [
          webCtx.webServer.register({
            kind: 'exact',
            path: STATUS_ROUTE,
            handler: handlers.status,
          }),
          webCtx.webServer.register({
            kind: 'exact',
            path: LOGS_ROUTE,
            handler: handlers.logs,
          }),
          webCtx.webServer.register({
            kind: 'exact',
            path: ACTION_ROUTE,
            handler: handlers.action,
          }),
          webCtx.webServer.register({
            kind: 'exact',
            path: EXTERNAL_ROUTE,
            handler: handlers.external,
          }),
        ];
        return () => {
          for (const dispose of disposers) dispose();
        };
      });
    };
    ctx.effect(() => ctx.inject(['webServer'], registerPanelRoutes));
  }
}
