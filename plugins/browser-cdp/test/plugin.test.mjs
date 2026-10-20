import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apply, inject, name, resolveDataDir } from '../index.js';
import { BROWSER_CDP_SKILL } from '../skill/index.js';

/**
 * 这一组测试用假 ctx 验证"装配"这一步：工具注册了没有、技能注册了没有、
 * 卸载时清理了没有。真机上最容易出错的恰恰是这一步——`ctx.tools.register`
 * 的返回值忘了丢、effect 没返回 disposer，都会在长跑进程里慢慢泄漏。
 */

/**
 * 造一个记录所有注册行为的假 ctx。
 *
 * @param {{ webServer?: boolean, skills?: boolean }} [options]
 */
function makeCtx(options = {}) {
  /** @type {any[]} */
  const tools = [];
  /** @type {any[]} */
  const skills = [];
  /** @type {any[]} */
  const routes = [];
  /** @type {(() => void)[]} */
  const effects = [];
  /** @type {string[]} */
  const warnings = [];

  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {
          const index = tools.indexOf(definition);
          if (index >= 0) tools.splice(index, 1);
        };
      },
    },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') effects.push(dispose);
      return () => {};
    },
    inject(names, callback) {
      if (options.webServer === true && names.includes('webServer')) {
        callback({
          webServer: {
            register(route) {
              routes.push(route);
              return () => {
                const index = routes.indexOf(route);
                if (index >= 0) routes.splice(index, 1);
              };
            },
          },
          effect(inner) {
            const dispose = inner();
            if (typeof dispose === 'function') effects.push(dispose);
            return () => {};
          },
        });
      }
    },
    get(service, _required) {
      if (service === 'skills') {
        if (options.skills === false) return undefined;
        return {
          register(skill) {
            skills.push(skill);
            return () => {
              const index = skills.indexOf(skill);
              if (index >= 0) skills.splice(index, 1);
            };
          },
        };
      }
      if (service === 'logger') return { warn: (message) => warnings.push(message) };
      return undefined;
    },
  };
  return { ctx, tools, skills, routes, effects, warnings };
}

/** 一份完整的默认配置（与 schemastery 解析后的形状一致）。 */
function makeConfig(overrides = {}) {
  return {
    dataDir: undefined,
    executablePath: undefined,
    browserPaths: [],
    portRange: undefined,
    headless: true,
    headlessMode: 'new',
    allowSandbox: false,
    chromiumArgs: [],
    windowSize: [1440, 900],
    commandTimeoutMs: 30000,
    stopBrowserOnUnload: true,
    enablePanelRoute: true,
    enableSkill: true,
    ...overrides,
  };
}

test('清单契约：name 与 inject 正确，且不声明任何宿主包依赖', () => {
  assert.equal(name, 'browser-cdp');
  // tools 是硬依赖；skills 与 webServer 必须走可选探测，否则在缺少它们的组合里插件不激活
  assert.deepEqual(inject, ['tools']);

  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

  // 这条断言是升级事故（0.2.0-rc.2 → 0.2.1-rc.2）的回归网：
  // 宿主包一旦写进 dependencies，pnpm 会把它装进 profile 并遮住宿主自带的那份。
  const declared = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) };
  const hostPackages = Object.keys(declared).filter((key) => key.startsWith('@deepseek-ai/'));
  assert.deepEqual(hostPackages, [], `不允许声明宿主包依赖：${hostPackages.join(', ')}`);

  // 兼容性只能通过 engines.dsh 声明（宿主 0.2.1 起会做精确校验）。
  assert.equal(typeof manifest.engines?.dsh, 'string');
  assert.match(manifest.engines.dsh, /\^?0\.2\./);
});

test('apply：非法配置回退默认值并记诊断，而不是让插件无法激活', () => {
  const { ctx, tools, warnings } = makeCtx();
  apply(ctx, makeConfig({ headless: 'yes', portRange: 12345, gracefulTimeoutMs: 'x', 未知项: 1 }));
  // 配置问题不该影响注册：工具仍然全部就位
  assert.equal(tools.length, 15);
  assert.match(warnings.join('\n'), /headless/);
  assert.match(warnings.join('\n'), /未知配置项/);
});

test('resolveDataDir：显式配置优先，其次 DSH_HOME，最后家目录', () => {
  assert.equal(resolveDataDir('/custom/dir'), '/custom/dir');
  assert.equal(resolveDataDir('   '), resolveDataDir(undefined));

  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/dsh-home-test';
  try {
    assert.equal(
      resolveDataDir(undefined),
      join('/tmp/dsh-home-test', 'plugin-data', 'browser-cdp'),
    );
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }

  delete process.env.DSH_HOME;
  assert.equal(resolveDataDir(undefined), join(homedir(), '.dsh-plugin-data', 'browser-cdp'));
});

test('apply：注册全部浏览器工具与技能，且注册的是同一份定义', () => {
  const { ctx, tools, skills } = makeCtx();
  apply(ctx, makeConfig());

  assert.equal(tools.length, 15);
  assert.ok(tools.some((tool) => tool.name === 'browser_open'));
  assert.ok(tools.some((tool) => tool.name === 'browser_close'));

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'browser-cdp');
  assert.equal(skills[0].content, BROWSER_CDP_SKILL.content);
  assert.equal(skills[0].source, 'plugin:browser-cdp');
  assert.deepEqual(skills[0].invocation, { modelInvocable: true, userInvocable: true });
});

test('apply：卸载后工具与技能都被撤下（不留下悬空注册）', () => {
  const { ctx, tools, skills, effects } = makeCtx();
  apply(ctx, makeConfig());
  assert.equal(tools.length, 15);

  for (const dispose of effects) dispose();
  assert.equal(tools.length, 0);
  // 技能通过 effect 注册，卸载后也应清空
  assert.equal(skills.length, 0);
});

test('apply：缺少 skills 服务时只记警告，工具照常注册', () => {
  const { ctx, tools, warnings } = makeCtx({ skills: false });
  apply(ctx, makeConfig());
  assert.equal(tools.length, 15);
  assert.match(warnings.join('\n'), /缺少 skills 服务/);
});

test('apply：enableSkill 为假时不注册技能', () => {
  const { ctx, skills } = makeCtx();
  apply(ctx, makeConfig({ enableSkill: false }));
  assert.equal(skills.length, 0);
});

test('apply：面板路由只在有 webServer 时注册，且拒绝非本机来源', async () => {
  const without = makeCtx();
  apply(without.ctx, makeConfig());
  assert.equal(without.routes.length, 0);

  const with_ = makeCtx({ webServer: true });
  apply(with_.ctx, makeConfig());
  assert.equal(with_.routes.length, 1);
  assert.equal(with_.routes[0].path, '/plugin/browser-cdp/status');

  /**
   * 造一个假的 res 收集响应。
   */
  const makeRes = () => {
    const chunks = [];
    return {
      statusCode: 0,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers ?? {};
      },
      end(body) {
        chunks.push(body);
      },
      body: () => chunks.join(''),
    };
  };

  const denied = makeRes();
  await with_.routes[0].handler({ socket: { remoteAddress: '10.0.0.9' } }, denied);
  assert.equal(denied.statusCode, 403);
  assert.match(denied.body(), /只允许从本机读取/);

  const allowed = makeRes();
  await with_.routes[0].handler({ socket: { remoteAddress: '127.0.0.1' } }, allowed);
  assert.equal(allowed.statusCode, 200);
  const payload = JSON.parse(allowed.body());
  assert.equal(payload.ok, true);
  // 未启动时状态如实报告，不谎报运行中
  assert.equal(payload.running, false);
  assert.match(payload.status, /浏览器未启动/);
  // 不能把可执行路径之类的本机细节漏给任何请求方
  assert.equal(payload.executablePath, null);
  assert.equal(allowed.headers['cache-control'], 'no-store');
});

test('apply：enablePanelRoute 为假时不注册路由', () => {
  const { ctx, routes } = makeCtx({ webServer: true });
  apply(ctx, makeConfig({ enablePanelRoute: false }));
  assert.equal(routes.length, 0);
});

test('技能定义：名字是 kebab-case、说明非空、正文含关键约定', () => {
  assert.match(BROWSER_CDP_SKILL.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(BROWSER_CDP_SKILL.description.length > 20);
  assert.ok(BROWSER_CDP_SKILL.whenToUse.length > 10);
  // 正文必须覆盖这几条关键约定，否则模型会误以为能操作内置浏览器、或用图像识别定位
  assert.match(BROWSER_CDP_SKILL.content, /Sidebar 浏览器/);
  // 而且要讲清"这是已核实的定论"，否则模型会反复尝试那条不可达的路
  assert.match(BROWSER_CDP_SKILL.content, /不要再试/);
  assert.match(BROWSER_CDP_SKILL.content, /app\.commandLine/);
  assert.match(BROWSER_CDP_SKILL.content, /browser_snapshot/);
  assert.match(BROWSER_CDP_SKILL.content, /引用号/);
});
