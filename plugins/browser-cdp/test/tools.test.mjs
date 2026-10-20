import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserTools, projectAction } from '../src/tools.js';

/**
 * 这一组测试用真实的 `defineTool`（依赖已按宿主同版本安装）来构造工具定义。
 *
 * 为什么值得这么做：`defineTool` 会在**构造时**校验参数与输出 schema 的形状，
 * 少写 `render`、把 `required` 写错层级、`object` 忘了 `additionalProperties`，
 * 都会当场抛错。也就是说，这组测试验证的是"工具声明能不能被宿主接受"——
 * 而那是纯 JS 插件最容易犯、也最难在本地发现的一类错误。
 */

/** 一个只记录调用、不碰浏览器的假会话。 */
function makeStubBrowser() {
  const calls = [];
  return {
    calls,
    ensure: async (options) => {
      calls.push(['ensure', options]);
      return {
        running: true,
        reused: false,
        port: 24000,
        browser: 'Chrome/155.0.0.0',
        protocolVersion: '1.3',
        product: 'Google Chrome',
        sandboxDisabled: false,
        profileDir: '/data/chromium-profile',
        cdpEndpoint: 'http://127.0.0.1:24000',
        page: {
          url: 'https://example.com/',
          title: 'Example',
          readyState: 'interactive',
          text: 'hello',
        },
      };
    },
    navigate: async (url, options) => {
      calls.push(['navigate', url, options]);
      return { url, title: 'T', readyState: 'interactive', text: 'body text' };
    },
    snapshot: async (options) => {
      calls.push(['snapshot', options]);
      return {
        url: 'https://example.com/',
        title: 'T',
        readyState: 'complete',
        scrollY: 0,
        scrollHeight: 900,
        viewport: { width: 1280, height: 800 },
        total: 1,
        truncated: false,
        items: [
          {
            ref: 'e1',
            tag: 'button',
            text: '提交',
            x: 100,
            y: 200,
            w: 80,
            h: 30,
            inViewport: true,
            state: { disabled: false },
          },
        ],
      };
    },
    click: async (target) => {
      calls.push(['click', target]);
      return actionReport('click', 'button e1 中心 (100, 200)');
    },
    type: async (options) => {
      calls.push(['type', options]);
      return actionReport('type', 'input e2');
    },
    press: async (options) => {
      calls.push(['press', options]);
      return actionReport('key', options.key);
    },
    wait: async (options) => {
      calls.push(['wait', options]);
      return { ok: true, waitedMs: 120, condition: 'selector .done', timedOut: false };
    },
    currentPageReport: async () => ({
      url: 'https://example.com/',
      title: 'T',
      readyState: 'complete',
      text: '',
    }),
    content: async (options) => {
      calls.push(['content', options]);
      return {
        url: 'https://example.com/',
        title: 'T',
        format: options.format ?? 'text',
        scope: options.ref ?? options.selector ?? 'body',
        content: 'hello world',
        length: 11,
        truncated: false,
      };
    },
    inspect: async (target) => {
      calls.push(['inspect', target]);
      return {
        found: true,
        element: { tag: 'input', text: '', value: 'abc', visible: true, disabled: false },
      };
    },
    screenshot: async (options) => {
      calls.push(['screenshot', options]);
      return {
        path: '/data/shots/shot.png',
        bytes: 1234,
        width: 1280,
        height: 800,
        fullPage: options.fullPage === true,
      };
    },
    evaluate: async (expression) => {
      calls.push(['evaluate', expression]);
      return { value: 42, type: 'number', unserializable: false };
    },
    readNetwork: (options) => {
      calls.push(['readNetwork', options]);
      return {
        dropped: 0,
        entries: [
          {
            requestId: '1',
            method: 'GET',
            url: 'https://example.com/a.js',
            startedAt: 0,
            status: 200,
            finishedAt: 0.05,
          },
          {
            requestId: '2',
            method: 'GET',
            url: 'https://example.com/b.png',
            startedAt: 0,
            failed: true,
            errorText: 'net::ERR_FAILED',
          },
        ],
      };
    },
    readConsole: (options) => {
      calls.push(['readConsole', options]);
      return {
        dropped: 0,
        entries: [{ level: 'error', source: 'exception', text: 'boom', at: 0 }],
      };
    },
    tabs: async (options) => {
      calls.push(['tabs', options]);
      return {
        action: options.action ?? 'list',
        tabs: [{ targetId: 't1', url: 'https://example.com/', title: 'T', current: true }],
        current: 't1',
      };
    },
    close: async () => {
      calls.push(['close']);
      return { closed: true, method: 'sigterm', waitedMs: 120 };
    },
    panelStatus: () => ({ running: false, status: '未启动' }),
  };
}

/**
 * 造一份动作报告（形状与 ManagedBrowser 返回的一致）。
 * @param {string} action
 * @param {string} target
 */
function actionReport(action, target) {
  return {
    action,
    target,
    ok: true,
    page: { url: 'https://example.com/', title: 'T', readyState: 'complete', text: 'after' },
    console: [{ level: 'error', text: 'boom', at: 0, source: 'exception' }],
    failedRequests: [
      {
        requestId: '2',
        method: 'GET',
        url: 'https://example.com/b.png',
        startedAt: 0,
        failed: true,
        errorText: 'net::ERR_FAILED',
      },
    ],
  };
}

/**
 * @param {any} tools
 * @param {string} name
 */
function toolNamed(tools, name) {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `没有注册名为 ${name} 的工具`);
  return found;
}

/** 工具集应当覆盖的能力（名字是公开契约，改名要同步改文档与技能）。 */
const EXPECTED_TOOLS = [
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_content',
  'browser_get',
  'browser_click',
  'browser_type',
  'browser_key',
  'browser_wait',
  'browser_screenshot',
  'browser_eval',
  'browser_network',
  'browser_console',
  'browser_tabs',
  'browser_close',
];

test('createBrowserTools：每个工具都能被 defineTool 接受，且名字完整', () => {
  const tools = createBrowserTools({ browser: makeStubBrowser() });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    EXPECTED_TOOLS,
  );
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 10, `${tool.name} 的描述太短`);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺少 output.render`);
    assert.equal(tool.parameters.type, 'object');
  }
});

test('browser_open：透传参数并渲染出端口与 profile', async () => {
  const browser = makeStubBrowser();
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_open');
  const value = await tool.execute({ url: 'example.com', headless: false, timeoutMs: 5000 }, {});
  assert.equal(value.port, 24000);
  assert.equal(value.browser, 'Chrome/155.0.0.0');
  assert.equal(value.pageTitle, 'Example');
  assert.deepEqual(browser.calls[0], [
    'ensure',
    { url: 'example.com', headless: false, timeoutMs: 5000 },
  ]);
  const rendered = tool.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /CDP 端口：24000/);
  assert.match(rendered[0].text, /chromium-profile/);
});

test('browser_open：省略 url 时传 undefined，不擅自变成空字符串', async () => {
  const browser = makeStubBrowser();
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_open');
  await tool.execute({}, {});
  const [, options] = browser.calls[0];
  assert.equal(options.url, undefined);
  assert.equal(options.headless, undefined);
});

test('browser_click：输出必须是声明的形状（内部 report 要投影）', async () => {
  const browser = makeStubBrowser();
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_click');
  const value = await tool.execute({ ref: 'e1' }, {});
  // 内部 report 的字段不能直接出现在工具输出里，否则过不了 schema 校验
  assert.equal(value.page, undefined);
  assert.equal(value.pageUrl, 'https://example.com/');
  assert.equal(value.pageTitle, 'T');
  assert.equal(value.ok, true);
  assert.equal(value.console.length, 1);
  assert.equal(value.failedRequests[0].errorText, 'net::ERR_FAILED');
  const rendered = tool.output.render({}, value);
  assert.match(rendered[0].text, /click：已执行/);
  assert.match(rendered[0].text, /最近控制台/);
});

test('browser_click：坐标与选择器都能落到 session 的同一个动作上', async () => {
  const browser = makeStubBrowser();
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_click');
  await tool.execute({ x: 10, y: 20, clickCount: 2 }, {});
  await tool.execute({ selector: '#submit' }, {});
  assert.deepEqual(browser.calls[0][1].x, 10);
  assert.equal(browser.calls[0][1].clickCount, 2);
  assert.equal(browser.calls[1][1].selector, '#submit');
});

test('browser_type：默认不提交，submit 为真时透传', async () => {
  const browser = makeStubBrowser();
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_type');
  await tool.execute({ ref: 'e2', text: 'hi' }, {});
  assert.equal(browser.calls[0][1].submit, false);
  await tool.execute({ ref: 'e2', text: 'hi', submit: true }, {});
  assert.equal(browser.calls[1][1].submit, true);
});

test('browser_eval：结构化结果按值序列化，渲染成可读文本', async () => {
  const browser = makeStubBrowser();
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_eval');
  const value = await tool.execute({ expression: '1 + 41' }, {});
  assert.deepEqual(value, { type: 'number', unserializable: false, value: 42 });
  assert.match(tool.output.render({}, value)[0].text, /number/);
});

test('browser_eval：不可序列化的结果要显式提示，而不是给个空值', async () => {
  const tool = toolNamed(createBrowserTools({ browser: makeStubBrowser() }), 'browser_eval');
  const rendered = tool.output.render({}, { type: 'function', unserializable: true, value: null });
  assert.match(rendered[0].text, /无法按值序列化/);
  assert.match(rendered[0].text, /JSON.stringify/);
});

test('browser_wait：超时是可判断的事实，渲染里要给下一步建议', async () => {
  const browser = makeStubBrowser();
  browser.wait = async () => ({
    ok: false,
    waitedMs: 10000,
    condition: 'selector .late',
    timedOut: true,
  });
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_wait');
  const value = await tool.execute({ selector: '.late', timeoutMs: 10000 }, {});
  assert.equal(value.ok, false);
  assert.equal(value.timedOut, true);
  const text = tool.output.render({}, value)[0].text;
  assert.match(text, /等待超时/);
  assert.match(text, /browser_snapshot/);
});

test('browser_snapshot：渲染成引用号表格，并标出视口外的元素', async () => {
  const browser = makeStubBrowser();
  browser.snapshot = async () => ({
    url: 'https://example.com/',
    title: 'T',
    readyState: 'complete',
    scrollY: 100,
    scrollHeight: 3000,
    viewport: { width: 1280, height: 800 },
    total: 2,
    truncated: true,
    items: [
      {
        ref: 'e1',
        tag: 'button',
        text: '提交',
        x: 1,
        y: 2,
        w: 3,
        h: 4,
        inViewport: true,
        state: {},
      },
      {
        ref: 'e2',
        tag: 'input',
        text: '',
        x: 1,
        y: 2000,
        w: 3,
        h: 4,
        inViewport: false,
        state: { disabled: true },
      },
    ],
  });
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_snapshot');
  const value = await tool.execute({}, {});
  const text = tool.output.render({}, value)[0].text;
  assert.match(text, /e1\tbutton\t提交/);
  assert.match(text, /视口外/);
  assert.match(text, /禁用/);
  assert.match(text, /只列出前 2 个/);
});

test('browser_snapshot：没有可交互元素时给出排查方向而不是空结果', async () => {
  const browser = makeStubBrowser();
  browser.snapshot = async () => ({
    url: 'about:blank',
    title: '',
    readyState: 'complete',
    scrollY: 0,
    scrollHeight: 0,
    viewport: { width: 800, height: 600 },
    total: 0,
    truncated: false,
    items: [],
  });
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_snapshot');
  const text = tool.output.render({}, await tool.execute({}, {}))[0].text;
  assert.match(text, /没有找到可交互元素/);
  assert.match(text, /browser_wait/);
});

test('browser_get：找不到元素时把原因原样带出', async () => {
  const browser = makeStubBrowser();
  browser.inspect = async () => ({ found: false, reason: '引用号 e9 已失效' });
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_get');
  const value = await tool.execute({ ref: 'e9' }, {});
  assert.equal(value.found, false);
  assert.match(tool.output.render({}, value)[0].text, /引用号 e9 已失效/);
});

test('browser_screenshot：只返回路径与尺寸，不把图像数据塞进结果', async () => {
  const browser = makeStubBrowser();
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_screenshot');
  const value = await tool.execute({ fullPage: true }, {});
  assert.equal(value.path, '/data/shots/shot.png');
  assert.equal(value.fullPage, true);
  assert.ok(!('data' in value));
  assert.match(tool.output.render({}, value)[0].text, /截图已保存/);
});

test('browser_network：失败请求渲染出失败原因', async () => {
  const browser = makeStubBrowser();
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_network');
  const value = await tool.execute({ onlyFailures: true }, {});
  assert.equal(value.entries[1].failed, true);
  const text = tool.output.render({}, value)[0].text;
  assert.match(text, /net::ERR_FAILED/);
});

test('browser_console：空缓冲区给出明确结论，而不是空白', async () => {
  const browser = makeStubBrowser();
  browser.readConsole = () => ({ dropped: 0, entries: [] });
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_console');
  const text = tool.output.render({}, await tool.execute({}, {}))[0].text;
  assert.match(text, /没有符合条件的记录/);
});

test('browser_tabs：列出标签并标出当前标签', async () => {
  const browser = makeStubBrowser();
  const tool = toolNamed(createBrowserTools({ browser }), 'browser_tabs');
  const value = await tool.execute({ action: 'list' }, {});
  assert.equal(value.action, 'list');
  assert.equal(value.tabs[0].current, true);
  assert.match(tool.output.render({}, value)[0].text, /\* t1/);
});

test('browser_close：渲染里说明 profile 会保留', async () => {
  const tool = toolNamed(createBrowserTools({ browser: makeStubBrowser() }), 'browser_close');
  const value = await tool.execute({}, {});
  assert.equal(value.closed, true);
  assert.match(tool.output.render({}, value)[0].text, /profile 保留/);
});

test('isAvailable 为假时所有工具都明确拒绝，而不是静默失败', async () => {
  const tools = createBrowserTools({ browser: makeStubBrowser(), isAvailable: () => false });
  await assert.rejects(() => toolNamed(tools, 'browser_open').execute({}, {}), /不可用/);
  await assert.rejects(() => toolNamed(tools, 'browser_close').execute({}, {}), /不可用/);
});

test('projectAction：把内部 report 投影成声明形状（含可选字段处理）', () => {
  const projected = projectAction({
    action: 'click',
    target: 'button e1',
    ok: true,
    page: { url: 'u', title: 't', readyState: 'complete', text: 'x' },
    console: [],
    failedRequests: [],
  });
  assert.deepEqual(projected, {
    action: 'click',
    target: 'button e1',
    ok: true,
    pageUrl: 'u',
    pageTitle: 't',
    pageText: 'x',
    console: [],
    failedRequests: [],
  });
  // 没有 page 时不能抛异常：动作成功但回读失败也要能报告出来
  const degraded = projectAction({
    action: 'click',
    target: 'x',
    ok: true,
    console: [],
    failedRequests: [],
  });
  assert.equal(degraded.pageUrl, '');
});
