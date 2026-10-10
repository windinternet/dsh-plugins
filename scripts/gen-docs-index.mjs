#!/usr/bin/env node
/**
 * 生成 docs/generated/plugins.md。
 *
 * 生成物是"事实源"的一部分，但只能由这个脚本产生：docs/generated/ 下的文件禁止手改，
 * docs:check 会比对本脚本的输出，过期即失败。这样注册表与文档表就永远一致。
 *
 * 用法：
 *   node scripts/gen-docs-index.mjs    写入文件
 *   import { buildGeneratedPlugins }   docs:check 用它比对
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 生成物路径（相对仓库根）。 */
export const GENERATED_PLUGINS_PATH = 'docs/generated/plugins.md';

/** kind 的中文说明。 */
const KIND_LABEL = {
  host: 'Host 插件',
  ui: 'UI 插件',
  mcp: 'MCP 接入',
};

/** status 的中文说明。 */
const STATUS_LABEL = {
  experimental: '实验性',
  stable: '稳定',
  draft: '草稿',
};

/** dataFlow 的中文说明。 */
const DATA_FLOW_LABEL = {
  'local-only': '仅本机',
  'network-optional': '可选联网',
  network: '需要联网',
};

/**
 * 生成插件清单 Markdown。
 * @returns {string}
 */
export function buildGeneratedPlugins() {
  const registry = JSON.parse(readFileSync(join(ROOT, 'plugins.json'), 'utf8'));
  const lines = [];

  lines.push('<!-- 由 scripts/gen-docs-index.mjs 生成，请勿手动编辑。 -->');
  lines.push('<!-- 修改内容请改 plugins.json，然后运行 pnpm docs:index。 -->');
  lines.push('');
  lines.push('# 插件清单');
  lines.push('');
  lines.push(
    '本表由 `plugins.json` 生成，是"仓库里有哪些插件"的唯一权威视图。' +
      '新增插件时先登记 `plugins.json`，再用 `pnpm create-plugin` 生成骨架。',
  );
  lines.push('');
  lines.push('## 插件');
  lines.push('');
  lines.push('| 插件 | 包名 | 形态 | 状态 | 数据流向 | 目录 | 规格 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');

  const plugins = registry.plugins ?? [];
  if (plugins.length === 0) {
    lines.push('| _暂无_ | | | | | | |');
  }
  for (const plugin of plugins) {
    const kinds = String(plugin.kind ?? '')
      .split('+')
      .filter(Boolean)
      .map((k) => KIND_LABEL[k] ?? k)
      .join(' + ');
    const specs = (plugin.specs ?? [])
      .map((spec) => `[规格](${'../'.repeat(1)}${spec.replace(/^docs\//, '')})`)
      .join(' ');
    lines.push(
      `| ${plugin.id} | \`${plugin.packageName}\` | ${kinds} | ${
        STATUS_LABEL[plugin.status] ?? plugin.status ?? '-'
      } | ${DATA_FLOW_LABEL[plugin.dataFlow] ?? plugin.dataFlow ?? '-'} | \`${plugin.dir}\` | ${specs || '-'} |`,
    );
  }

  lines.push('');
  lines.push('## 共享包');
  lines.push('');
  lines.push('| 包 | 包名 | 目录 | 说明 |');
  lines.push('| --- | --- | --- | --- |');
  const shared = registry.sharedPackages ?? [];
  if (shared.length === 0) {
    lines.push('| _暂无_ | | | |');
  }
  for (const pkg of shared) {
    lines.push(`| ${pkg.id} | \`${pkg.packageName}\` | \`${pkg.dir}\` | ${pkg.summary ?? '-'} |`);
  }

  lines.push('');
  lines.push('## 插件摘要');
  lines.push('');
  for (const plugin of plugins) {
    lines.push(`### ${plugin.id}`);
    lines.push('');
    lines.push(plugin.summary ?? '_未填写摘要_');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('生成命令：`pnpm docs:index`');
  lines.push('');

  return lines.join('\n');
}

function main() {
  const content = buildGeneratedPlugins();
  const path = join(ROOT, GENERATED_PLUGINS_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  console.log(`已生成 ${GENERATED_PLUGINS_PATH}`);
}

// 仅在直接执行时写文件；被 import 时只提供纯函数，方便 docs:check 比对。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
