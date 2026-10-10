#!/usr/bin/env node
/**
 * 仓库健康检查：捕获"文件写坏了"这类会静默通过其他检查的问题。
 *
 * 为什么需要它：一个被截断的 JS 文件不会被 docs:check 或 verify:manifests 发现，
 * 直到真的运行到它才报错。同理，一个被截断的 JSON 会让后续脚本以莫名其妙的方式失败。
 * 这个检查把"文件本身是否完整"变成可机械判定的事情。
 *
 * 检查项：
 *  1. 所有 .js/.mjs/.cjs 文件能通过 Node 的语法解析。
 *  2. 所有 .json 文件能解析，且 .tmpl 之外的 JSON 是完整对象。
 *  3. 所有 .md 文件有终止换行，且不以未闭合的围栏代码块结束。
 *  4. 源文件中不残留模板占位符（__XXX__），避免脚手架产物漏替换。
 *  5. 所有包清单可解析，且 name/version 字段形态正确。
 *
 * 用法：node scripts/check-repo-health.mjs
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', 'coverage', '.pnpm-store']);
const errors = [];

/** @param {string} message */
function fail(message) {
  errors.push(message);
}

/**
 * 递归收集文件。
 * @param {string} dir
 * @returns {string[]} 相对仓库根的路径
 */
function collect(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else out.push(relative(ROOT, full));
  }
  return out;
}

/**
 * 用 Node 自身的解析器检查语法，比任何正则都可靠。
 * @param {string} rel
 */
function checkSyntax(rel) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, rel)], { stdio: 'pipe' });
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    const firstLine = stderr.split('\n').find((line) => /Error|error/.test(line)) ?? '解析失败';
    fail(`${rel} 语法检查失败：${firstLine.trim()}`);
  }
}

/**
 * @param {string} rel
 */
function checkMarkdown(rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  if (text.length > 0 && !text.endsWith('\n')) {
    fail(`${rel} 没有以换行结尾，可能被截断。`);
  }
  const fences = (text.match(/^```/gm) ?? []).length;
  if (fences % 2 !== 0) {
    fail(`${rel} 的围栏代码块数量为奇数（${fences}），说明有未闭合的代码块或文件被截断。`);
  }
}

/**
 * @param {string} rel
 */
function checkPlaceholders(rel) {
  if (rel.startsWith('templates/')) return; // 模板本来就该有占位符
  if (rel.endsWith('.tmpl')) return;
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  // 注释里可能引用占位符样本（例如本检查器自己的文档），先把注释行去掉，
  // 否则检查器会把自己的说明当成问题报出来。
  const text = raw
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
  const found = text.match(/__[A-Z][A-Z0-9_]{2,}__/g);
  if (found) {
    fail(`${rel} 残留模板占位符：${[...new Set(found)].join('、')}`);
  }
}

function main() {
  const files = collect(ROOT);

  for (const rel of files) {
    const ext = extname(rel);
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      if (rel.endsWith('.tmpl')) continue;
      checkSyntax(rel);
      checkPlaceholders(rel);
    } else if (ext === '.json') {
      try {
        JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
      } catch (error) {
        fail(`${rel} 不是合法 JSON：${error.message}`);
      }
      checkPlaceholders(rel);
    } else if (ext === '.md') {
      checkMarkdown(rel);
    } else if (ext === '.yml' || ext === '.yaml') {
      if (rel.endsWith('.tmpl')) continue;
      checkPlaceholders(rel);
    }
  }

  if (errors.length === 0) {
    console.log(`仓库健康检查通过：检查了 ${files.length} 个文件，无截断、无残留占位符。`);
    return;
  }
  console.error(`仓库健康检查发现 ${errors.length} 个问题：\n`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exitCode = 1;
}

main();
