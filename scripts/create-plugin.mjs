#!/usr/bin/env node
/**
 * 按 plugins.json 的登记条目生成插件骨架。
 *
 * 用法：
 *   pnpm create-plugin <plugin-id> [--force]
 *
 * 设计意图：让"新增一个插件"变成一次可重复的操作，而不是靠复制粘贴旧插件。
 * 复制粘贴会带上旧插件的残留，而这些残留没有任何检查能发现。
 *
 * 刻意不做的事：
 * - 不替你写 plugins.json。注册表是权威事实，生成器只读它。
 * - 不替你写 README 与 product-specs。那两样需要人想清楚"做什么"，模板写不出。
 *   生成后 verify:manifests 与 docs:check 会提醒你补上。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** kind → 模板目录。含 ui 时用 ui-plugin，其次 mcp，最后 host。 */
function pickTemplate(kind) {
  const kinds = String(kind ?? '').split('+');
  if (kinds.includes('ui')) return 'ui-plugin';
  if (kinds.includes('mcp')) return 'mcp-bundle';
  if (kinds.includes('host')) return 'host-plugin';
  return null;
}

/**
 * 递归列出模板目录下的文件。
 * @param {string} dir
 * @returns {string[]} 相对模板根的路径
 */
function listTemplateFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTemplateFiles(full).map((p) => join(name, p)));
    } else {
      out.push(name);
    }
  }
  return out;
}

/**
 * 替换占位符。末尾的 .tmpl 会被去掉。
 * @param {string} text
 * @param {Record<string, string>} values
 * @returns {string}
 */
function render(text, values) {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`__${key}__`).join(value);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const force = process.argv.includes('--force');
  const id = args[0];

  if (!id) {
    console.error('用法：pnpm create-plugin <plugin-id> [--force]');
    console.error('plugin-id 必须是 plugins.json 中已登记的条目 id。');
    process.exitCode = 1;
    return;
  }

  const registry = JSON.parse(readFileSync(join(ROOT, 'plugins.json'), 'utf8'));
  const entry = (registry.plugins ?? []).find((p) => p.id === id);
  if (!entry) {
    console.error(`plugins.json 里没有 id 为 "${id}" 的条目。`);
    console.error(
      '请先登记条目（id、packageName、dir、kind、summary、status、dataFlow、specs），再运行本命令。',
    );
    process.exitCode = 1;
    return;
  }

  const templateName = pickTemplate(entry.kind);
  if (!templateName) {
    console.error(`无法从 kind="${entry.kind}" 推断模板；应为 host、ui、mcp 的组合。`);
    process.exitCode = 1;
    return;
  }

  const targetDir = join(ROOT, entry.dir);
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !force) {
    console.error(`${entry.dir} 已存在且非空。加 --force 才会覆盖（不推荐）。`);
    process.exitCode = 1;
    return;
  }

  const templateDir = join(ROOT, 'templates', templateName);
  const values = {
    PLUGIN_ID: entry.id,
    PACKAGE_NAME: entry.packageName,
    SUMMARY: entry.summary ?? entry.id,
    SUMMARY_EN: entry.summaryEn ?? entry.summary ?? entry.id,
  };

  const written = [];
  for (const rel of listTemplateFiles(templateDir)) {
    const source = readFileSync(join(templateDir, rel), 'utf8');
    const targetRel = rel.endsWith('.tmpl') ? rel.slice(0, -'.tmpl'.length) : rel;
    const target = join(targetDir, targetRel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, render(source, values), 'utf8');
    written.push(relative(ROOT, target));
  }

  console.log(`已用模板 ${templateName} 生成 ${entry.dir}：`);
  for (const file of written.sort()) console.log(`  ${file}`);

  console.log('\n还需要你手工完成：');
  console.log(
    `  1. 写 ${entry.dir}/README.md，并在其中声明数据流向（${entry.dataFlow ?? '未指定'}）。`,
  );
  for (const spec of entry.specs ?? []) {
    console.log(`  2. 写产品规格 ${spec}，包含验收标准。`);
  }
  if ((entry.specs ?? []).length === 0) {
    console.log('  2. 在 plugins.json 里补上 specs，并写下对应的产品规格文档。');
  }
  console.log('  3. 把 src/ 里的占位实现替换成真实逻辑，并补测试。');
  console.log('  4. 运行 pnpm check 与 pnpm docs:index。');
}

main();
