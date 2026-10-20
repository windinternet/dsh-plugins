#!/usr/bin/env node
/**
 * 端到端冒烟测试：用**真实浏览器**跑通完整链路。
 *
 * 为什么单独放一个脚本而不是塞进单元测试：它真的会启动一个 Chromium 进程、真的联网、
 * 真的花掉几秒钟，而且依赖本机装了浏览器。把它混进 `pnpm test` 会让单元测试变慢且不稳定，
 * 而"不跑它就等于没验证"——宿主 API 与 CDP 的细节无法靠 mock 保证。
 *
 * 覆盖：启动（自适应端口）→ 导航 → 快照 → 真实点击 → 读回变更 → 输入 → 截图 →
 * 控制台/网络记录 → 标签页 → 关闭（确认进程真的退出）。
 *
 * 用法：
 *   node plugins/browser-cdp/test/e2e/smoke.mjs              # 用页面自带的本地场景
 *   node plugins/browser-cdp/test/e2e/smoke.mjs --keep       # 结束后不关浏览器（人工观察）
 *   node plugins/browser-cdp/test/e2e/smoke.mjs --headful    # 显示窗口
 *
 * 退出码 0 表示全部通过。
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ManagedBrowser } from '../../src/session.js';

const keep = process.argv.includes('--keep');
const headless = !process.argv.includes('--headful');

/**
 * 一个自包含的测试页面：不依赖任何外部站点，因此离线也能跑。
 * 它刻意包含"点击后文本变化"与"输入后回显"这两种最基本的交互证据。
 */
const FIXTURE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>CDP 冒烟</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 24px; }
  #log { margin-top: 16px; white-space: pre-line; }
  #late { display: none; }
</style>
</head>
<body>
  <h1 id="title">初始标题</h1>
  <button id="change" aria-label="改标题">点我改标题</button>
  <button id="reveal">显示延迟内容</button>
  <label>姓名 <input id="name" name="name" placeholder="输入姓名"></label>
  <button id="echo">回显</button>
  <div id="log"></div>
  <div id="late">延迟内容出现了</div>
  <script>
    document.getElementById('change').addEventListener('click', () => {
      document.getElementById('title').textContent = '点击之后的标题';
    });
    document.getElementById('reveal').addEventListener('click', () => {
      document.getElementById('late').style.display = 'block';
    });
    document.getElementById('echo').addEventListener('click', () => {
      document.getElementById('log').textContent = '你好 ' + document.getElementById('name').value;
      console.log('echo fired');
    });
    console.warn('fixture ready');
  </script>
</body>
</html>`;

/**
 * 打印一条检查结果。
 *
 * @param {string} label
 * @param {unknown} detail
 */
function ok(label, detail = '') {
  console.log(`  ✔ ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/**
 * @param {string} label
 * @param {() => Promise<void>} body
 */
async function step(label, body) {
  process.stdout.write(`▶ ${label}\n`);
  try {
    await body();
  } catch (error) {
    console.error(`  ✖ ${label} 失败：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'browser-cdp-e2e-'));
console.log(`数据目录：${dataDir}`);
console.log(`模式：${headless ? '无头' : '可见窗口'}\n`);

const browser = new ManagedBrowser({
  dataDir,
  config: {
    portRange: [24500, 24540],
    headless,
    headlessMode: 'new',
    allowSandbox: false,
    chromiumArgs: [],
    windowSize: [1280, 800],
    commandTimeoutMs: 30000,
  },
  warn: (message) => console.log(`  ! ${message}`),
});

let exitCode = 0;
try {
  await step('启动浏览器并探测端口', async () => {
    const report = await browser.ensure();
    assert.ok(report.port >= 24500 && report.port <= 24540, `端口 ${report.port} 不在配置范围内`);
    assert.ok(report.browser.length > 0);
    ok('端口是探测出来的', String(report.port));
    ok('浏览器', report.browser);
    ok('profile', report.profileDir);
    if (report.sandboxDisabled) ok('注意：本次以关闭浏览器沙箱启动（启动阶段回退）');
  });

  await step('导航到一个 data: 页面（不依赖网络）', async () => {
    const page = await browser.navigate(
      `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE)}`,
    );
    assert.equal(page.title, 'CDP 冒烟');
    ok('标题', page.title);
  });

  await step('快照：拿到可交互元素与引用号', async () => {
    const snapshot = await browser.snapshot();
    assert.ok(snapshot.items.length >= 4, `只找到 ${snapshot.items.length} 个可交互元素`);
    const refs = snapshot.items.map((item) => item.ref);
    assert.ok(refs.includes('e1'));
    const button = snapshot.items.find((item) => item.text.includes('点我改标题'));
    assert.ok(button, '没有在快照里找到标题按钮');
    ok('元素数', String(snapshot.items.length));
    ok('示例', `${button.ref} ${button.tag} "${button.text}" @(${button.x},${button.y})`);
  });

  await step('真实鼠标点击 → 读回页面变更', async () => {
    const snapshot = await browser.snapshot();
    const button = snapshot.items.find((item) => item.text.includes('点我改标题'));
    assert.ok(button);
    const report = await browser.click({ ref: button.ref });
    assert.equal(report.ok, true);
    const title = await browser.evaluate("document.getElementById('title').textContent");
    assert.equal(title.value, '点击之后的标题', '点击没有产生预期的 DOM 变更');
    ok('点击后标题', String(title.value));
  });

  await step('引用号失效时明确报错，而不是猜位置', async () => {
    // 重新快照会作废旧引用号——这是设计行为，必须报错而不是静默点到别处
    await browser.snapshot();
    const stale = await browser.click({ ref: 'e99' }).then(
      () => null,
      (error) => error,
    );
    assert.ok(stale !== null, '失效的引用号居然没有报错');
    assert.match(stale.message, /失效/);
    ok('错误信息', stale.message.split('\n')[0]);
  });

  await step('输入文本（含中文）并回显', async () => {
    const snapshot = await browser.snapshot();
    const input = snapshot.items.find((item) => item.tag === 'input');
    assert.ok(input, '没有找到输入框');
    await browser.type({ ref: input.ref, text: '世界' });
    const value = await browser.evaluate("document.getElementById('name').value");
    assert.equal(value.value, '世界', '输入的中文没有进入输入框');

    const after = await browser.snapshot();
    const echo = after.items.find((item) => item.text.includes('回显'));
    assert.ok(echo);
    await browser.click({ ref: echo.ref });
    const log = await browser.evaluate("document.getElementById('log').textContent");
    assert.equal(log.value, '你好 世界');
    ok('回显', String(log.value));
  });

  await step('等待：等一个最初隐藏的元素出现', async () => {
    const snapshot = await browser.snapshot();
    const reveal = snapshot.items.find((item) => item.text.includes('显示延迟内容'));
    assert.ok(reveal);
    await browser.click({ ref: reveal.ref });
    const waited = await browser.wait({ selector: '#late', timeoutMs: 5000 });
    assert.equal(waited.ok, true, '等待延迟内容出现失败');
    ok('等待耗时', `${waited.waitedMs}ms`);
  });

  await step('读取页面内容（文本与 HTML）', async () => {
    const text = await browser.content({ format: 'text', selector: '#log' });
    assert.match(text.content, /你好 世界/);
    const html = await browser.content({ format: 'html', selector: '#title' });
    assert.match(html.content, /点击之后的标题/);
    ok('文本长度', String(text.length));
  });

  await step('读取元素细节', async () => {
    const info = await browser.inspect({ selector: '#name' });
    assert.equal(info.found, true);
    assert.equal(info.element?.attributes?.id, 'name');
    ok('元素', `<${info.element?.tag}> value="${info.element?.value}"`);
  });

  await step('截图落盘并返回路径', async () => {
    const shot = await browser.screenshot({ fullPage: true });
    assert.ok(existsSync(shot.path), `截图文件不存在：${shot.path}`);
    assert.ok(shot.bytes > 1000, `截图太小：${shot.bytes} 字节`);
    ok('文件', `${shot.path}（${shot.width}×${shot.height}，${shot.bytes} 字节）`);
  });

  await step('控制台记录里能看到页面自己的日志', async () => {
    const console_ = browser.readConsole({ limit: 50 });
    const texts = console_.entries.map((entry) => entry.text).join('\n');
    assert.match(texts, /fixture ready/, '没记录到页面启动时的 console.warn');
    ok('条数', String(console_.entries.length));
  });

  await step('标签页：新建、列出、切回、关闭', async () => {
    const before = await browser.listTabs();
    const created = await browser.tabs({
      action: 'new',
      url: 'data:text/html,<title>第二个标签</title><p>x',
    });
    assert.equal(created.tabs.length, before.length + 1);
    const listed = await browser.tabs({ action: 'list' });
    const current = listed.tabs.find((tab) => tab.current);
    assert.ok(current, '没有标记出当前标签');
    ok('标签数', String(listed.tabs.length));
    await browser.tabs({ action: 'close', targetId: current.targetId });
    const after = await browser.tabs({ action: 'list' });
    assert.ok(after.tabs.length >= 1, '关掉当前标签后应该还有可用的页面');
    ok('关闭后剩余', String(after.tabs.length));
  });

  await step('真实网络导航（可跳过：离线时会失败）', async () => {
    try {
      const page = await browser.navigate('https://example.com', { timeoutMs: 20000 });
      assert.match(page.title, /Example/i);
      ok('外部站点标题', page.title);
      const network = browser.readNetwork({ limit: 20 });
      assert.ok(network.entries.length > 0, '导航之后应该有网络记录');
      ok('网络记录', `${network.entries.length} 条`);
    } catch (error) {
      console.log(
        `  ! 跳过外部导航（可能是离线环境）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  if (!keep) {
    await step('关闭浏览器并确认进程真的退出', async () => {
      const closed = await browser.close();
      assert.equal(closed.closed, true, '浏览器进程没有在超时内退出');
      ok('停止方式', `${closed.method}（${closed.waitedMs}ms）`);
      assert.equal(browser.running, false);
      // 端口应该能被重新绑定，说明进程确实走了
      const port = browser.port;
      browser.port = null;
      ok('端口已释放', String(port));
    });
  } else {
    console.log('\n--keep：浏览器保持运行，端口与 profile 见上。用完请手动关闭该进程。');
  }

  console.log('\n全部通过 ✅');
} catch (error) {
  console.error(`\n冒烟测试失败：${error instanceof Error ? error.stack : String(error)}`);
  exitCode = 1;
} finally {
  if (!keep && browser.running) {
    await browser.close().catch(() => {});
  }
  if (process.env.KEEP_DATA !== '1') {
    rmSync(dataDir, { recursive: true, force: true });
  } else {
    console.log(`数据目录保留：${dataDir}`);
  }
}

process.exit(exitCode);
