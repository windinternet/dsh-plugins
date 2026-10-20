import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BROWSER_PATHS,
  PATH_CANDIDATES,
  describeMissingBrowser,
  discoverBrowser,
  productNameOf,
  searchPath,
} from '../src/launcher.js';
import { buildChromiumArgs } from '../src/chromium.js';

/**
 * 「找不到浏览器」是使用者最可能遇到的第一个失败，因此发现顺序与失败信息都要可测：
 * 失败信息里必须列出找过的位置，否则使用者无从判断是没装还是装在了别处。
 */

test('discoverBrowser：显式配置优先，且不再往后找', () => {
  const result = discoverBrowser({
    configured: '/custom/chrome',
    candidates: ['/candidate/chrome'],
    isFile: (path) => path === '/custom/chrome' || path === '/candidate/chrome',
    pathSearch: () => ['/path/chrome'],
  });
  assert.equal(result.path, '/custom/chrome');
  assert.equal(result.source, 'configured');
  assert.deepEqual(result.checked, ['/custom/chrome']);
});

test('discoverBrowser：配置路径不存在时记录原因，并继续找候选', () => {
  const result = discoverBrowser({
    configured: '/custom/chrome',
    candidates: ['/candidate/chrome'],
    isFile: (path) => path === '/candidate/chrome',
    pathSearch: () => [],
  });
  assert.equal(result.path, '/candidate/chrome');
  assert.equal(result.source, 'candidate');
  assert.match(result.problems.join('\n'), /executablePath 配置指向的文件不存在/);
  assert.deepEqual(result.checked, ['/custom/chrome', '/candidate/chrome']);
});

test('discoverBrowser：没有配置时按平台默认位置，再退到 PATH', () => {
  const fromPath = discoverBrowser({
    isFile: (path) => path === '/usr/local/bin/chromium',
    pathSearch: () => ['/usr/local/bin/chromium'],
  });
  assert.equal(fromPath.path, '/usr/local/bin/chromium');
  assert.equal(fromPath.source, 'path');
  // 默认位置全部被检查过（顺序稳定，便于人核对）
  assert.deepEqual(fromPath.checked, [...DEFAULT_BROWSER_PATHS, '/usr/local/bin/chromium']);

  const none = discoverBrowser({ isFile: () => false, pathSearch: () => [] });
  assert.equal(none.path, null);
  assert.equal(none.source, null);
  assert.ok(none.checked.length >= DEFAULT_BROWSER_PATHS.length);
});

test('searchPath：按 PATH 顺序在候选目录里找已知的可执行名', () => {
  const found = searchPath({
    pathEnv: ['/first', '/second'].join(':'),
    pathSep: ':',
    isFile: (path) => path === '/second/chromium',
  });
  assert.deepEqual(found, ['/second/chromium']);
  assert.ok(PATH_CANDIDATES.includes('chromium'));
  assert.ok(PATH_CANDIDATES.includes('google-chrome'));
});

test('searchPath：空 PATH 段被忽略，不产生 `/chromium` 这种相对路径', () => {
  const found = searchPath({ pathEnv: '::/only:', pathSep: ':', isFile: () => true });
  assert.ok(found.every((path) => path.startsWith('/only/')));
});

test('describeMissingBrowser：给出原因、找过的位置与下一步动作', () => {
  const text = describeMissingBrowser({
    checked: ['/a', '/b'],
    problems: ['executablePath 配置指向的文件不存在：/x'],
  });
  assert.match(text, /没有找到可用的 Chromium 系浏览器/);
  assert.match(text, /executablePath 配置指向的文件不存在/);
  assert.match(text, /- \/a/);
  assert.match(text, /- \/b/);
  assert.match(text, /executablePath/);
});

test('describeMissingBrowser：位置很多时截断，但报出被省略的数量', () => {
  const checked = Array.from({ length: 60 }, (_value, index) => `/p${index}`);
  const text = describeMissingBrowser({ checked, problems: [] });
  assert.match(text, /还有 20 处未列出/);
});

test('productNameOf：从可执行文件名推断产品名', () => {
  assert.equal(
    productNameOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    'Google Chrome',
  );
  assert.equal(productNameOf('/usr/bin/chromium'), 'Chromium');
  assert.equal(productNameOf('C:\\Program Files\\x\\msedge.exe'), 'msedge');
});

test('buildChromiumArgs：必需开关齐全，无头与沙箱按参数决定', () => {
  const args = buildChromiumArgs({
    executablePath: '/chrome',
    port: 24000,
    userDataDir: '/data/profile',
    headless: true,
    headlessMode: 'new',
    allowSandbox: false,
    extraArgs: ['--lang=zh-CN'],
    windowSize: [1280, 800],
    initialUrl: 'about:blank',
  });
  assert.ok(args.includes('--remote-debugging-port=24000'));
  assert.ok(args.includes('--user-data-dir=/data/profile'));
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--no-sandbox'));
  assert.ok(args.includes('--window-size=1280,800'));
  assert.ok(args.includes('--lang=zh-CN'));
  // URL 必须是位置参数，且排在最后
  assert.equal(args.at(-1), 'about:blank');
  // 首次运行向导与默认浏览器检查必须关掉，否则会弹窗挡住自动化
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--no-default-browser-check'));
});

test('buildChromiumArgs：允许沙箱时不加 --no-sandbox，可见模式不加 --headless', () => {
  const args = buildChromiumArgs({
    executablePath: '/chrome',
    port: 24001,
    userDataDir: '/data/profile',
    headless: false,
    headlessMode: 'old',
    allowSandbox: true,
    extraArgs: [],
    windowSize: [1440, 900],
    initialUrl: 'https://example.com',
  });
  assert.ok(!args.some((arg) => arg.startsWith('--headless')));
  assert.ok(!args.includes('--no-sandbox'));
  assert.equal(args.at(-1), 'https://example.com');
});
