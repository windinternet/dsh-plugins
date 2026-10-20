/**
 * 查找本机的 Chromium 系浏览器。
 *
 * 为什么要单独一层：不同机器上浏览器装在哪完全不可预测，而"找不到浏览器"
 * 是使用者最可能遇到的第一个失败。因此这里的原则是**把找过的位置全部报出来**，
 * 让人一眼看出是"没装"还是"装在预期之外的地方"，而不是抛一句模糊的启动失败。
 *
 * 只做发现，不做启动：启动与渲染进程崩溃回退在 chromium.js 里。
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** 按优先级排列的候选。macOS 上 Chrome 最常见，因此排在前面。 */
export const DEFAULT_BROWSER_PATHS = /** @type {const} */ ([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  '/Applications/Arc.app/Contents/MacOS/Arc',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]);

/** PATH 上按名字查找的候选。 */
export const PATH_CANDIDATES = /** @type {const} */ ([
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
]);

/**
 * 判断一个路径是否是可执行文件。
 *
 * 刻意不用 access(X_OK)：在 macOS 的 .app 包内部，可执行位的检查会引入
 * 与沙箱相关的噪声，而"文件存在"已经足够把候选缩小到可验证的范围，
 * 真正的可执行性由启动失败来暴露，并且失败信息里带着具体路径。
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isExecutableFile(path) {
  if (typeof path !== 'string' || path.trim() === '') return false;
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * 在 PATH 里找候选。
 *
 * @param {object} [options]
 * @param {string} [options.pathEnv] PATH 环境变量
 * @param {string} [options.pathSep] 路径分隔符
 * @param {(path: string) => boolean} [options.isFile] 注入点，便于测试
 * @returns {string[]}
 */
export function searchPath(options = {}) {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const sep = options.pathSep ?? delimiter;
  const isFile = options.isFile ?? isExecutableFile;
  /** @type {string[]} */
  const found = [];
  const dirs = pathEnv.split(sep).filter((dir) => dir !== '');
  for (const name of PATH_CANDIDATES) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (isFile(candidate)) found.push(candidate);
    }
  }
  return found;
}

/**
 * 找浏览器。顺序：显式配置 → 配置的候选列表 → 平台常见位置 → PATH。
 *
 * @param {object} [options]
 * @param {string} [options.configured] Config.executablePath
 * @param {string[]} [options.candidates] Config.browserPaths
 * @param {(path: string) => boolean} [options.isFile] 注入点，便于测试
 * @param {() => string[]} [options.pathSearch] 注入点，便于测试
 * @returns {{ path: string | null, source: 'configured' | 'candidate' | 'default' | 'path' | null, checked: string[], problems: string[] }}
 */
export function discoverBrowser(options = {}) {
  const isFile = options.isFile ?? isExecutableFile;
  const pathSearch = options.pathSearch ?? (() => searchPath({ isFile }));
  /** @type {string[]} */
  const checked = [];
  /** @type {string[]} */
  const problems = [];

  if (typeof options.configured === 'string' && options.configured.trim() !== '') {
    const configured = options.configured.trim();
    checked.push(configured);
    if (isFile(configured)) return { path: configured, source: 'configured', checked, problems };
    problems.push(`executablePath 配置指向的文件不存在：${configured}`);
  }

  const configuredList = Array.isArray(options.candidates) ? options.candidates : [];
  for (const candidate of configuredList) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    const path = candidate.trim();
    checked.push(path);
    if (isFile(path)) return { path, source: 'candidate', checked, problems };
  }

  for (const candidate of DEFAULT_BROWSER_PATHS) {
    checked.push(candidate);
    if (isFile(candidate)) return { path: candidate, source: 'default', checked, problems };
  }

  for (const candidate of pathSearch()) {
    checked.push(candidate);
    if (isFile(candidate)) return { path: candidate, source: 'path', checked, problems };
  }

  return { path: null, source: null, checked, problems };
}

/**
 * 给"找不到浏览器"生成一条可操作的错误信息。
 *
 * 失败信息是接口的一部分：它必须告诉使用者下一步做什么（装一个，或者配 executablePath），
 * 并附上找过的位置，让人能判断是漏配还是真没装。
 *
 * @param {{ checked: string[], problems: string[] }} result
 * @returns {string}
 */
export function describeMissingBrowser(result) {
  const lines = ['本机没有找到可用的 Chromium 系浏览器。'];
  if (result.problems.length > 0) lines.push(...result.problems.map((p) => `- ${p}`));
  lines.push('已查找的位置：');
  const shown = result.checked.slice(0, 40);
  lines.push(...shown.map((p) => `- ${p}`));
  if (result.checked.length > shown.length)
    lines.push(`- （还有 ${result.checked.length - shown.length} 处未列出）`);
  lines.push('解决办法：安装 Google Chrome / Chromium / Edge，或在插件配置里设置 executablePath。');
  return lines.join('\n');
}

/** Chromium 系浏览器的可执行文件名（用于从路径推断产品名，仅用于展示）。 */
const PRODUCT_BY_BASENAME = /** @type {Record<string, string>} */ ({
  'Google Chrome': 'Google Chrome',
  'Google Chrome Canary': 'Google Chrome Canary',
  Chromium: 'Chromium',
  'Microsoft Edge': 'Microsoft Edge',
  'Brave Browser': 'Brave',
  Vivaldi: 'Vivaldi',
  Arc: 'Arc',
  'google-chrome': 'Google Chrome',
  'google-chrome-stable': 'Google Chrome',
  chromium: 'Chromium',
  'chromium-browser': 'Chromium',
  'microsoft-edge': 'Microsoft Edge',
  'brave-browser': 'Brave',
});

/**
 * 从可执行文件路径推断一个给人看的产品名。
 *
 * @param {string} path
 * @returns {string}
 */
export function productNameOf(path) {
  const base = path.split(/[/\\]/).pop() ?? path;
  return PRODUCT_BY_BASENAME[base] ?? base.replace(/\.exe$/i, '');
}
