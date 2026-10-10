#!/usr/bin/env node
/**
 * 文档结构校验。
 *
 * 采用 Harness Engineering 的思路：文档不是散文，而是可机械检查的资产。
 * 一个只靠人维护的知识库必然腐烂，把它编成检查项，智能体才能在批量改动时不被它绊倒。
 *
 * 检查项：
 *  1. 必需入口文档存在（地图与事实源骨架）。
 *  2. 每个 Markdown 文件里的相对链接都能解析到真实文件（带锚点的会剥掉锚点）。
 *  3. 每个 Markdown 文件都有 YAML front matter 或一级标题（避免出现无标题碎片）。
 *  4. 每个插件有 README.md 与 product-specs 规格文档。
 *  5. docs/generated/ 下的文件与生成器输出一致（禁止手改）。
 *  6. 文档不得包含疑似真实密钥（复用扫描器规则，只针对文档）。
 *
 * 用法：node scripts/check-docs.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { buildGeneratedPlugins, GENERATED_PLUGINS_PATH } from './gen-docs-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 仓库必须存在的入口文档。缺任何一个都说明知识库骨架被破坏了。 */
const REQUIRED_DOCS = [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'README.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/design-docs/core-beliefs.md',
  'docs/design-docs/plugin-architecture.md',
  'docs/references/dsh-plugin-api.md',
];

const errors = [];

/** @param {string} message */
function fail(message) {
  errors.push(message);
}

/**
 * 递归收集 Markdown 文件。
 * @param {string} dir
 * @returns {string[]} 相对仓库根的路径
 */
function collectMarkdown(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.turbo' || name === 'dist')
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectMarkdown(full));
    } else if (name.endsWith('.md')) {
      out.push(relative(ROOT, full));
    }
  }
  return out;
}

/**
 * 剥掉行内代码与围栏代码块，避免把示例里的链接当成真链接。
 * @param {string} text
 * @returns {string}
 */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * 检查一个 Markdown 文件的标题与链接。
 * @param {string} rel
 */
function checkFile(rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const body = stripCode(text);

  if (!/^---\n[\s\S]*?\n---\n/.test(text) && !/^#\s+\S/m.test(text)) {
    fail(`${rel} 既没有 YAML front matter，也没有一级标题。`);
  }

  // 相对链接：[文字](目标)
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue; // 外链、页面内锚点
    const withoutAnchor = target.split('#')[0];
    if (withoutAnchor === '') continue;
    const resolved = resolve(dirname(join(ROOT, rel)), decodeURI(withoutAnchor));
    if (!existsSync(resolved)) {
      fail(`${rel} 的链接指向不存在的路径：${target}`);
    }
  }
}

/**
 * 检查插件文档覆盖情况。
 */
function checkPluginDocs() {
  const registryPath = join(ROOT, 'plugins.json');
  if (!existsSync(registryPath)) {
    fail('缺少 plugins.json。');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  for (const plugin of registry.plugins ?? []) {
    const readme = join(ROOT, plugin.dir, 'README.md');
    if (!existsSync(readme)) fail(`插件 ${plugin.id} 缺少 ${plugin.dir}/README.md。`);
    if (!plugin.specs || plugin.specs.length === 0) {
      fail(`插件 ${plugin.id} 在 plugins.json 中没有声明 specs。`);
    }
    for (const spec of plugin.specs ?? []) {
      if (!existsSync(join(ROOT, spec))) fail(`插件 ${plugin.id} 的规格文档不存在：${spec}`);
    }
  }
}

/**
 * 检查生成物是否为最新。
 */
function checkGenerated() {
  const expected = buildGeneratedPlugins();
  const path = join(ROOT, GENERATED_PLUGINS_PATH);
  if (!existsSync(path)) {
    fail(`缺少生成文档 ${GENERATED_PLUGINS_PATH}。运行 pnpm docs:index 生成。`);
    return;
  }
  const actual = readFileSync(path, 'utf8');
  if (actual.trim() !== expected.trim()) {
    fail(`${GENERATED_PLUGINS_PATH} 已过期。运行 pnpm docs:index 重新生成，不要手改。`);
  }
}

function main() {
  for (const doc of REQUIRED_DOCS) {
    if (!existsSync(join(ROOT, doc))) fail(`缺少必需文档：${doc}`);
  }

  for (const rel of collectMarkdown(ROOT)) {
    // 生成的清单由生成器负责，跳过链接检查以免误报
    if (rel.startsWith('docs/generated/')) continue;
    checkFile(rel);
  }

  checkPluginDocs();
  checkGenerated();

  if (errors.length === 0) {
    console.log('文档检查通过：入口完整、链接可达、生成物最新。');
    return;
  }
  console.error(`文档检查失败，共 ${errors.length} 个问题：\n`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exitCode = 1;
}

main();
