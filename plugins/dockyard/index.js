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
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DockyardService } from './src/service.js';

/** 稳定的 Loader 标识。 */
export const name = 'dockyard';

/** 本插件需要的宿主服务。`webServer` 是可选能力，缺少时面板降级为不可用。 */
export const inject = ['tools'];

/**
 * 插件配置。用户在 profile 的 cordis.patch.yml 里覆盖这些字段；
 * 那份 patch 层能挺过插件升级，所以可调参数都应该放在这里。
 */
export const Config = z.object({
  /**
   * 插件数据目录。缺省时按 DSH_HOME 推导（见 resolveDataDir）。
   * 建议显式配置，避免跟随工作目录漂移。
   */
  dataDir: z.string(),
  /** 停止进程时的宽限窗口：先发温和终止信号，超时后升级为强杀。 */
  gracefulTimeoutMs: z.number().default(5000),
  /** 升级为强杀后等待进程消失的上限。 */
  killTimeoutMs: z.number().default(3000),
  /** 插件卸载时是否连带停止被托管的进程。默认否——进程不该随客户端消失。 */
  stopProcessesOnUnload: z.boolean().default(false),
  /** 是否注册面板所需的只读 HTTP 路由。关闭后 UI 面板显示为不可用。 */
  enablePanelRoute: z.boolean().default(true),
});

/**
 * 面板路由的路径。用固定前缀而不是随机值，便于在浏览器与日志里辨认。
 */
const PANEL_ROUTE = '/plugin/dockyard/status';

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
 * @param {any} config 经 Config 校验后的配置
 */
export function apply(ctx, config) {
  const dataDir = resolveDataDir(config.dataDir);

  const service = new DockyardService({
    dataDir,
    onWarn: (message) => warn(ctx, `[dockyard] ${message}`),
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
          const lines = value.map(
            (/** @type {any} */ item) =>
              `${item.name} [${item.status}] ${item.command} ${item.dir}` +
              (item.pid ? ` (pid ${item.pid})` : '') +
              (item.statusReason ? ` — ${item.statusReason}` : ''),
          );
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
        '扫描本机目录，找出可运行的开发服务（Node 脚本、Python 入口、可执行 shell 脚本），并给出每个候选的判定理由。不写入任何内容。',
      parameters: {
        roots: {
          type: 'array',
          required: true,
          description: '要扫描的根目录绝对路径列表。',
          items: { type: 'string' },
        },
        maxDepth: { type: 'integer', description: '最大递归深度，默认 4。' },
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
        const result = await service.scan(args.roots, { maxDepth: args.maxDepth });
        const lines = result.candidates.map(
          (candidate) =>
            `${candidate.alreadyAdded ? '[已托管] ' : ''}${candidate.name}（${candidate.runner}）\n` +
            `  目录：${candidate.dir}\n  命令：${candidate.command} ${candidate.args.join(' ')}\n` +
            `  理由：${candidate.reason}`,
        );
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
            `扫描了 ${result.scannedDirs} 个目录，发现 ${result.candidates.length} 个候选应用。\n` +
            (lines.length > 0 ? lines.join('\n') : '（没有发现可运行的应用）'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'dockyard_add',
      description:
        '把一个扫描出来的候选应用加入 dockyard 托管列表。必须先扫描取得 candidateId，不要凭猜测构造 id。',
      parameters: {
        candidateId: {
          type: 'string',
          required: true,
          description: 'dockyard_scan 返回的候选 id。',
        },
        roots: {
          type: 'array',
          required: true,
          description: '与取得该候选时相同的扫描根目录，用于重新确认该候选仍然存在。',
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
        // 重新扫描一次而不是从调用方取值：候选定义以当前磁盘事实为准，
        // 避免把一份已经过时的描述写进托管列表。
        const result = await service.scan(args.roots);
        const candidate = result.candidates.find((item) => item.id === args.candidateId);
        if (!candidate) {
          return {
            added: false,
            reason: `没有找到 id 为 ${args.candidateId} 的候选应用，请重新执行 dockyard_scan。`,
          };
        }
        // 候选的 runner 由扫描器产出，只可能是这三种之一；重新标注以满足服务层的类型。
        return service.add(/** @type {any} */ (candidate));
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

  // 面板数据通道：注册一个只读的 exact 路由。
  //
  // webServer 是可选服务：不声明 inject 就直接读 ctx.webServer 会抛异常，
  // 而声明成静态 inject 又会让插件在没有 HTTP 服务的组合里完全不激活。
  // 正确做法是 scoped inject——宿主在服务可用时才运行这段代码，
  // 服务不存在时插件其余部分照常工作。
  if (config.enablePanelRoute) {
    /**
     * 注册面板路由的 scoped 回调。
     * @param {any} webCtx 带 webServer 的子上下文
     */
    const registerPanelRoute = (webCtx) => {
      webCtx.webServer.register({
        kind: 'exact',
        path: PANEL_ROUTE,
        /**
         * @param {import('node:http').IncomingMessage} req
         * @param {import('node:http').ServerResponse} res
         */
        handler: async (req, res) => {
          // 只允许本机读取：这个路由暴露的是本机进程信息。
          const remote = req.socket?.remoteAddress ?? '';
          const isLoopback =
            remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
          if (!isLoopback) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'dockyard 状态只允许从本机读取。' }));
            return;
          }
          // 不设置 CORS 头：跨站页面无法读取响应，避免网页探测本机进程列表。
          try {
            const applications = await service.list();
            const body = JSON.stringify({
              ok: true,
              generatedAt: Date.now(),
              applications,
              warnings: service.store.problems,
            });
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(body);
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        },
      });
    };
    ctx.effect(() => ctx.inject(['webServer'], registerPanelRoute));
  }
}
