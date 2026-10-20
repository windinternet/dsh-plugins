#!/usr/bin/env node
/**
 * 由 skill/browser-cdp.md 生成 skill/index.js。
 *
 * 为什么要生成而不是手写两份：技能正文既是给人读的文档，也是要注册进会话目录的内容。
 * 两份副本一定会漂移——改了一处忘了另一处，而这两处的读者（人 / 模型）都不会报错，
 * 只会各自拿到过期的知识。所以正文只有一份事实源（Markdown），JS 模块由它生成，
 * `docs:check` 会比对两者是否一致（见 scripts/check-docs.mjs）。
 *
 * 用法：
 *   node plugins/browser-cdp/scripts/sync-skill.mjs          # 写入
 *   node plugins/browser-cdp/scripts/sync-skill.mjs --check  # 只校验，不一致就退出 1
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 找到仓库根目录。
 *
 * 需要它是因为正文的事实源放在 docs/ 下（技能正文先是文档，其次才是生成的注册内容），
 * 而生成物在插件目录里。用 plugins.json 作为根标记向上找，比数 `../..` 稳。
 *
 * @param {string} start
 * @returns {string}
 */
export function findRepoRoot(start) {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, 'plugins.json'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`从 ${start} 向上找不到含 plugins.json 的仓库根目录。`);
}

const ROOT = findRepoRoot(HERE);
const SOURCE = join(ROOT, 'docs', 'product-specs', 'browser-cdp-skill.md');
const TARGET = join(HERE, '..', 'skill', 'index.js');
const SOURCE_LABEL = 'docs/product-specs/browser-cdp-skill.md';

/**
 * 解析 frontmatter 与正文。
 *
 * 刻意不引 YAML 库：这里的 frontmatter 形态是受约束的（三个标量字段），
 * 一个 30 行的解析器比多一个依赖更容易审阅，也更容易在出错时给出可读信息。
 *
 * @param {string} text
 * @param {string} file
 * @returns {{ fields: Record<string, string>, body: string }}
 */
export function parseSkillFile(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match === null) throw new Error(`${file} 缺少 YAML frontmatter。`);
  const frontmatter = match[1] ?? '';
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of frontmatter.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator < 0) throw new Error(`${file} 的 frontmatter 行不是 key: value 形式：${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    fields[key] = value;
  }
  return { fields, body: (match[2] ?? '').trim() };
}

/**
 * 生成模块源码。
 *
 * @param {Record<string, string>} fields
 * @param {string} body
 * @param {string} sourceLabel
 * @returns {string}
 */
export function renderModule(fields, body, sourceLabel) {
  for (const required of ['name', 'description']) {
    if (fields[required] === undefined || fields[required] === '') {
      throw new Error(`skill frontmatter 缺少必填字段 ${required}。`);
    }
  }
  /** @param {unknown} value */
  const literal = (value) => JSON.stringify(value);
  return `/**
 * 由 ${sourceLabel} 生成，请勿手改。
 *
 * 重新生成：node plugins/browser-cdp/scripts/sync-skill.mjs
 * 一致性由 pnpm docs:check 校验。
 */

/** 技能名（kebab-case，注册进会话技能目录时用）。 */
export const SKILL_NAME = ${literal(fields.name)};

/** 面向模型的技能定义。content 是 Markdown 正文，按需加载。 */
export const BROWSER_CDP_SKILL = {
  name: SKILL_NAME,
  description: ${literal(fields.description)},
  ${fields.whenToUse === undefined ? '' : `whenToUse: ${literal(fields.whenToUse)},\n  `}content: ${literal(body)},
};
`;
}

/**
 * @param {boolean} check
 * @returns {number} 进程退出码
 */
function main(check) {
  const text = readFileSync(SOURCE, 'utf8');
  const { fields, body } = parseSkillFile(text, SOURCE);
  const generated = renderModule(fields, body, SOURCE_LABEL);

  if (check) {
    let current = '';
    try {
      current = readFileSync(TARGET, 'utf8');
    } catch {
      console.error('skill/index.js 不存在。运行：node plugins/browser-cdp/scripts/sync-skill.mjs');
      return 1;
    }
    if (current !== generated) {
      console.error(
        'skill/index.js 与 skill/browser-cdp.md 不一致。\n' +
          '修复：node plugins/browser-cdp/scripts/sync-skill.mjs',
      );
      return 1;
    }
    console.log('skill 生成物是最新的。');
    return 0;
  }

  writeFileSync(TARGET, generated);
  console.log(`已写入 ${TARGET}（正文 ${body.length} 字符）。`);
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('sync-skill.mjs')) {
  process.exit(main(process.argv.includes('--check')));
}
