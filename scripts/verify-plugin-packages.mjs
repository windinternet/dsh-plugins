#!/usr/bin/env node
/**
 * 插件包的依赖边界校验。
 *
 * 这个脚本来自一次真实的启动事故：插件把 `@deepseek-ai/dsh-tools` 写成普通依赖，
 * pnpm 就把它装进了 profile 的 `node_modules`；宿主按**包名**解析配置树里的行，
 * profile 里的同名包抢先命中、遮住宿主自带的那份。宿主升级后精确版本校验失败，
 * `tools` 行被禁用，所有依赖工具服务的插件一起挂掉，启动直接失败。
 *
 * 结论写成规则：**插件不得声明任何 `@deepseek-ai/*` 宿主包**（dependencies、
 * peerDependencies、optionalDependencies 都不行——peer 会被 pnpm 自动安装，同样落进 profile）。
 * 兼容性只能用 `engines.dsh` 声明，由宿主做版本裁决。
 *
 * 检查项：
 *  1. 插件清单不得含任何 `@deepseek-ai/*` 依赖（含 peer / optional）。
 *  2. 插件清单必须声明 `engines.dsh`，否则宿主升级时只能靠运气。
 *  3. 插件代码不得 import 任何 `@deepseek-ai/*` 包（注释里提到不算）。
 *  4. 非宿主依赖只要有就必须显式登记在注册表的 `runtimeDependencies` 里，便于评审时看见。
 *
 * 用法：node scripts/verify-plugin-packages.mjs
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_SCOPE = '@deepseek-ai/';
const SKIP_DIRS = new Set(['node_modules', '.turbo', 'dist', 'coverage']);

const errors = [];
const warnings = [];

/**
 * @param {string} message
 */
function fail(message) {
  errors.push(message);
}

/**
 * 递归收集源码文件（只扫真正会被加载的扩展名）。
 *
 * @param {string} dir
 * @returns {string[]}
 */
function collectSources(dir) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const entries = readdirSync(dir);
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) out.push(...collectSources(full));
    else if (/\.(?:js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * 去掉注释，保留字符串字面量。
 *
 * 为什么需要它：源码里用注释写"不要这样写 `from '@deepseek-ai/...'`"是很常见的提示，
 * 全文正则会把这种提示当成真实导入。这个扫描器按字符走，跳过字符串，只在字符串外
 * 识别 `//` 与 `/* ... *\/`，因此注释被移除、字符串原样保留。
 *
 * 不追求完整的 JS 词法分析（模板字符串里的 `${}` 不递归），因为这里只需要
 * "不把注释当代码"这一个性质。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    if (ch === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      index += 1;
      while (index < text.length) {
        const current = text[index];
        out += current;
        if (current === '\\') {
          out += text[index + 1] ?? '';
          index += 2;
          continue;
        }
        index += 1;
        if (current === quote) break;
      }
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * 把字符串字面量替换成带序号的占位符，并返回原文。
 *
 * 目的：`import x from 'pkg'` 的包名本身就在字符串里，所以不能简单删掉字符串；
 * 但字符串里出现的 "import ..." 文本又不是导入。做法是先抽出所有字符串（保留原文），
 * 把位置替换成不可能出现在 JS 里的 `\u0001序号\u0001`，再在剩余代码上匹配导入语法，
 * 命中占位符就回查原文。这样既能读包名，又不会被字符串或注释误导。
 *
 * @param {string} text 已去掉注释的源码
 * @returns {{ masked: string, strings: string[] }}
 */
export function maskStrings(text) {
  /** @type {string[]} */
  const strings = [];
  let masked = '';
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch !== '"' && ch !== "'" && ch !== '`') {
      masked += ch;
      index += 1;
      continue;
    }
    const quote = ch;
    index += 1;
    let value = '';
    while (index < text.length) {
      const current = text[index];
      if (current === '\\') {
        value += text[index + 1] ?? '';
        index += 2;
        continue;
      }
      index += 1;
      if (current === quote) break;
      value += current;
    }
    strings.push(value);
    masked += `\u0001${strings.length - 1}\u0001`;
  }
  return { masked, strings };
}

/**
 * 从一段源码里找出所有 `@deepseek-ai/*` 的导入。
 *
 * 只认三种真实语法（静态 import / 动态 import() / require），并且：
 * 先剥注释、再遮字符串，因此注释与字符串里提到包名都不会被误判。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function findHostImports(text) {
  const { masked, strings } = maskStrings(stripComments(text));
  const pattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)\u0001(\d+)\u0001/g;
  const found = new Set();
  for (const match of masked.matchAll(pattern)) {
    const value = strings[Number(match[1])];
    if (typeof value === 'string' && value.startsWith('@deepseek-ai/')) found.add(value);
  }
  return [...found];
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(
      `${relative(ROOT, file)} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function main() {
  const registry = readJson(join(ROOT, 'plugins.json'));
  if (registry === null) {
    report();
    return;
  }

  const declaredRuntimeDeps = new Set();
  for (const plugin of registry.plugins ?? []) {
    for (const name of plugin.runtimeDependencies ?? [])
      declaredRuntimeDeps.add(`${plugin.id}:${name}`);
  }

  for (const plugin of registry.plugins ?? []) {
    const dir = join(ROOT, plugin.dir);
    const manifest = readJson(join(dir, 'package.json'));
    if (manifest === null) continue;

    // 规则 1：任何 @deepseek-ai/* 依赖都会在 profile 里遮住宿主自带的包。
    const groups = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];
    for (const group of groups) {
      const declared = manifest[group];
      if (declared === undefined || declared === null) continue;
      for (const name of Object.keys(declared)) {
        if (!name.startsWith(HOST_SCOPE)) continue;
        fail(
          `${plugin.packageName} 的 ${group} 声明了宿主包 ${name}。\n` +
            '    后果：pnpm 会把它装进 profile，按包名遮住宿主自带的那份；宿主一升级就触发精确版本校验失败，\n' +
            '    `tools` 行被禁用，全部工具类插件一起失效（docs/references/dsh-plugin-upgrade-failure.md）。\n' +
            '    修复：删除该依赖，改用包内实现；兼容性用 engines.dsh 声明。',
        );
      }
      // 规则 4：非宿主依赖要显式登记，评审时能看见。
      for (const name of Object.keys(declared)) {
        if (name.startsWith(HOST_SCOPE)) continue;
        if (group === 'devDependencies') continue;
        if (!declaredRuntimeDeps.has(`${plugin.id}:${name}`)) {
          fail(
            `${plugin.packageName} 的 ${group} 含未登记依赖 ${name}。\n` +
              '    插件会被装进用户的 profile，任何依赖都随插件落地。请先确认它不会遮住宿主包，\n' +
              `    再在 plugins.json 的 runtimeDependencies 里登记（当前插件 id: ${plugin.id}）。`,
          );
        }
      }
    }

    // 规则 2：没有 engines.dsh，宿主升级时没有任何护栏。
    const dshRange = manifest.engines?.dsh;
    if (typeof dshRange !== 'string' || dshRange.trim() === '') {
      fail(
        `${plugin.packageName} 缺少 engines.dsh。\n` +
          '    宿主 0.2.1 起按 engines.dsh 做兼容性裁决：不声明就只能靠运行时碰运气，\n' +
          '    而失败现象往往是"整个启动挂掉"而不是一条清楚的提示。\n' +
          '    修复：在 package.json 加 `"engines": { "dsh": "^0.2.0-rc.2" }`。',
      );
    }

    // 规则 3：代码里也不许 import 宿主包。
    for (const file of collectSources(dir)) {
      const imports = findHostImports(readFileSync(file, 'utf8'));
      if (imports.length === 0) continue;
      fail(
        `${relative(ROOT, file)} 导入了宿主包：${imports.join(', ')}。\n` +
          '    插件代码不得依赖宿主内部包（它们不稳定，而且会诱发上面的 profile 遮蔽问题）。\n' +
          '    需要工具定义/配置归一化时用 src/internal/ 下的同名实现；需要宿主服务时用 ctx.inject。',
      );
    }
  }

  report();
}

function report() {
  if (warnings.length > 0) {
    for (const message of warnings) console.warn(`警告：${message}`);
  }
  if (errors.length === 0) {
    console.log('插件依赖边界检查通过：没有插件声明或导入宿主内部包，且都声明了 engines.dsh。');
    return;
  }
  console.error(`插件依赖边界检查失败，共 ${errors.length} 个问题：\n`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exitCode = 1;
}

/**
 * 判断是否被直接执行。
 *
 * 必须先 realpath 再比较：macOS 的临时目录 `/var/...` 实际是 `/private/var/...`，
 * 直接字符串比较会把"直接执行"误判成"被 import"，脚本于是静默不检查。
 *
 * @returns {boolean}
 */
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
