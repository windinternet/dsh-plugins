/**
 * browser-cdp 的 Host 半侧入口。
 *
 * 这一层只做适配：把宿主能力（工具注册表、技能注册表、可选的 HTTP 路由）
 * 接到 src/ 的浏览器会话上。所有页面语义都在 src/session.js 里，可脱离宿主用真实浏览器测试。
 *
 * 设计上的一句实话：**DSH Desktop 内置的 Sidebar 浏览器无法被插件自动化。**
 * 官方决策记录写明该实现不提供 remote-debugging 端点，插件也拿不到 Electron 的
 * webContents（插件跑在 ELECTRON_RUN_AS_NODE 的宿主子进程里）。官方认可的形态是
 * 由提供方自己启动一个 Chromium，本插件做的正是这件事。依据与出处见
 * docs/references/chromium-cdp-facts.md。
 *
 * 数据流向：local-only。浏览器进程、profile、截图都在本机；CDP 通道是 127.0.0.1 上的
 * 回环 WebSocket。被访问的网页自身会联网，那是浏览器在被使用，不是插件在发数据。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from './src/internal/config.js';
import { ManagedBrowser } from './src/session.js';
import { createBrowserTools } from './src/tools.js';
import { BROWSER_CDP_SKILL } from './skill/index.js';

/** 稳定的 Loader 标识。 */
export const name = 'browser-cdp';

/**
 * 本插件必须能注册工具，因此 `tools` 是硬依赖。
 * 其余能力（skills、webServer）都是可选的，用 ctx.inject / ctx.get 探测，
 * 不写进这里——inject 里的每一项都是硬需求，缺一项插件就完全不激活。
 */
export const inject = ['tools'];

/** 状态面板的只读路由。固定前缀便于在日志与浏览器里辨认。 */
const STATUS_ROUTE = '/plugin/browser-cdp/status';

/**
 * 插件配置的规格表。用户在 profile 的 cordis.patch.yml 里覆盖这些字段；
 * 那份 patch 层能挺过插件升级，所以可调参数都应该放在这里。
 *
 * **为什么不是 schemastery 的 `Config`。** 声明 `Config` 需要 import 宿主自带的
 * schemastery；一旦把它写成依赖，pnpm 就会在 profile 里装出第二份宿主包，遮住宿主
 * 自带的版本——宿主升级后精确版本校验失败，`tools` 行被禁用，所有工具类插件一起失效
 * （真实事故，见 docs/references/dsh-plugin-upgrade-failure.md）。配置校验不是激活的
 * 必要条件，因此这里用规格表自行归一化：不合法就回退默认值并记一条诊断。
 *
 * @type {Record<string, import('./src/internal/config.js').ConfigField>}
 */
const CONFIG_SPEC = {
  dataDir: { type: 'string' },
  executablePath: { type: 'string' },
  browserPaths: { type: 'array', default: [] },
  portRange: { type: 'any', default: [24000, 24060] },
  headless: { type: 'boolean', default: true },
  headlessMode: { type: 'string', default: 'new', values: ['new', 'old'] },
  allowSandbox: { type: 'boolean', default: false },
  chromiumArgs: { type: 'array', default: [] },
  windowSize: { type: 'array', default: [1440, 900] },
  commandTimeoutMs: { type: 'number', default: 30000 },
  stopBrowserOnUnload: { type: 'boolean', default: true },
  enablePanelRoute: { type: 'boolean', default: true },
  enableSkill: { type: 'boolean', default: true },
};

/**
 * 安全地记录一条警告。
 *
 * 刻意不把 logger 写进 inject：为了写一条警告而让插件在缺少该服务的组合里
 * 完全不激活，代价远大于收益。探测式读取，取不到就退回 console。
 *
 * @param {any} ctx
 * @param {string} message
 */
function warn(ctx, message) {
  const logger = typeof ctx.get === 'function' ? ctx.get('logger', false) : undefined;
  if (logger && typeof logger.warn === 'function') {
    logger.warn(`[browser-cdp] ${message}`);
    return;
  }
  console.warn(`[browser-cdp] ${message}`);
}

/**
 * 推导插件数据目录。
 *
 * 不依赖 ctx 上的宿主路径服务：那些服务需要声明 inject 才能读，而它们在不同组合里
 * 未必存在。环境变量 + 家目录足以算出一个确定位置，且在任意组合下都成立。
 *
 * @param {string | undefined} configured
 * @returns {string}
 */
export function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured;
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.trim() !== '')
    return join(home, 'plugin-data', 'browser-cdp');
  return join(homedir(), '.dsh-plugin-data', 'browser-cdp');
}

/**
 * 插件入口。
 *
 * @param {any} ctx
 * @param {any} rawConfig profile patch 里的原始 config，由 CONFIG_SPEC 归一化
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(CONFIG_SPEC, rawConfig, (/** @type {string} */ message) =>
    warn(ctx, message),
  );
  const dataDir = resolveDataDir(config.dataDir);
  const browser = new ManagedBrowser({
    config,
    dataDir,
    warn: (message) => warn(ctx, message),
  });

  // 1) 工具：本插件的核心。注册在插件的 effect 里，卸载即撤下。
  ctx.effect(() => {
    const disposers = createBrowserTools({ browser }).map((definition) =>
      ctx.tools.register(definition),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  });

  // 2) 技能：把方法论随插件带进会话目录。缺 skills 服务时静默跳过，
  //    因为工具本身就带描述，技能只是让用法更稳，不该成为激活的硬条件。
  if (config.enableSkill) {
    const skills = typeof ctx.get === 'function' ? ctx.get('skills', false) : undefined;
    if (skills === undefined) {
      warn(ctx, '缺少 skills 服务，方法论技能没有注册；工具本身照常可用。');
    } else {
      ctx.effect(() => {
        try {
          const dispose = skills.register({
            name: BROWSER_CDP_SKILL.name,
            description: BROWSER_CDP_SKILL.description,
            whenToUse: BROWSER_CDP_SKILL.whenToUse,
            content: BROWSER_CDP_SKILL.content,
            source: 'plugin:browser-cdp',
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

  // 3) 面板路由：可选服务，用 scoped inject，服务不存在时插件其余部分照常工作。
  if (config.enablePanelRoute) {
    /**
     * @param {any} webCtx 带 webServer 的子上下文
     */
    const registerPanelRoute = (webCtx) => {
      webCtx.effect(() => {
        const dispose = webCtx.webServer.register({
          kind: 'exact',
          path: STATUS_ROUTE,
          /**
           * @param {import('node:http').IncomingMessage} req
           * @param {import('node:http').ServerResponse} res
           */
          handler: (req, res) => {
            // 面板暴露的是本机浏览器信息，只允许回环来源读取；也不加 CORS 头。
            const remote = req.socket?.remoteAddress ?? '';
            const loopback =
              remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
            if (!loopback) {
              res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'browser-cdp 状态只允许从本机读取。' }));
              return;
            }
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify({ ok: true, ...browser.panelStatus() }));
          },
        });
        return () => dispose();
      });
    };
    ctx.inject(['webServer'], registerPanelRoute);
  }

  // 4) 卸载时收尾：默认关掉浏览器，避免留下占着端口的孤儿进程。
  ctx.effect(() => {
    return () => {
      const stopping = config.stopBrowserOnUnload ? browser.close() : browser.disconnect();
      // 卸载钩子不能 await，也不该让宿主因为清理失败而卡住：失败只记一条。
      Promise.resolve(stopping).catch((error) => {
        warn(ctx, `关闭浏览器时出错：${error instanceof Error ? error.message : String(error)}`);
      });
    };
  });
}
