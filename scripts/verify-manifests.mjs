#!/usr/bin/env node
/**
 * 校验插件注册表与包清单的一致性。
 *
 * 这是本仓库最重要的结构性检查：DSH 插件是"包清单即契约"的体系，一个写错的
 * dsh.bundle.patch 路径或拼错的包名，只会在用户安装时以难懂的方式失败。把这类
 * 错误提前到 CI，是让智能体能安全批量改动的必要前提。
 *
 * 检查项：
 *  1. plugins.json 中每个条目的 dir 存在，且该目录有 package.json。
 *  2. package.json.name 与注册表 packageName 一致。
 *  3. 声明 kind 含 host 时，必须有 dsh.bundle.patch，且该文件存在、YAML 可解析、
 *     顶层是数组、每行有 id 与 name。
 *  4. 声明 kind 含 ui 时，必须有 dsh.client 与 ./client 导出，且 client 入口存在。
 *  5. 每个插件的 cordis.patch.yml 里出现的行 id 在同一插件内唯一。
 *  6. specs 指向的文档必须存在。
 *  7. 反向检查：plugins/ 与 packages/ 下的每个包都已在注册表登记。
 *
 * 用法：node scripts/verify-manifests.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

/** @param {string} message */
function fail(message) {
  errors.push(message);
}

/** @param {string} message */
function warn(message) {
  warnings.push(message);
}

/**
 * 读取并解析 JSON，失败时记录错误并返回 null。
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file} 无法解析为 JSON：${error.message}`);
    return null;
  }
}

/**
 * 极简 YAML 解析：只处理本仓库用到的"顶层数组 + 每项若干标量字段"形态。
 * 刻意不引入 js-yaml 依赖——插件 patch 的形态是受约束的，解析器也应保持可审阅。
 * @param {string} text
 * @param {string} file
 * @returns {{ id?: string, name?: string, raw: string }[] | null}
 */
function parsePatchYaml(text, file) {
  const rows = [];
  let current = null;
  let inInsert = false;

  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '' || line.trimStart().startsWith('#')) continue;

    if (/^-\s*insert:\s*$/.test(line) || /^insert:\s*$/.test(line)) {
      inInsert = true;
      continue;
    }
    if (/^-\s*insert:\s*\[/.test(line)) {
      fail(`${file}:${index + 1} 暂不支持行内数组形式的 insert，请改用块列表。`);
      return null;
    }
    if (/^\s*-\s+id:/.test(line)) {
      // 新行开始
      current = { raw: line };
      const value = line
        .split('id:')[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, '');
      if (value) current.id = value;
      rows.push(current);
      continue;
    }
    if (/^\s*-\s+/.test(line) && !/^\s*-\s+(id|name):/.test(line)) {
      // 顶层列表里出现了既非 insert 也非 id 的行
      if (!inInsert) {
        fail(`${file}:${index + 1} 顶层列表项必须是 insert 或带 id 的覆盖项：${line.trim()}`);
      }
      continue;
    }
    if (current) {
      const nameMatch = line.match(/^\s*name:\s*(.+)$/);
      if (nameMatch) current.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return rows;
}

/**
 * 主流程。
 */
function main() {
  const registry = readJson(join(ROOT, 'plugins.json'));
  if (!registry) {
    report();
    return;
  }

  const entries = [...(registry.plugins ?? []), ...(registry.sharedPackages ?? [])];
  if (entries.length === 0) warn('plugins.json 里没有任何条目。');

  const registeredDirs = new Set();

  /** 共享包不是可安装的插件，因此不要求声明 kind。 */
  const isPlugin = (entry) => (registry.plugins ?? []).includes(entry);

  for (const entry of entries) {
    const label = entry.id ?? '(缺少 id)';
    if (!entry.id || !entry.packageName || !entry.dir) {
      fail(`注册表条目 ${label} 缺字段：需要 id、packageName、dir。`);
      continue;
    }
    const dir = resolve(ROOT, entry.dir);
    registeredDirs.add(entry.dir);

    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      fail(`注册表条目 ${label} 的 dir 不存在：${entry.dir}`);
      continue;
    }
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) {
      fail(`注册表条目 ${label} 缺少 package.json：${entry.dir}/package.json`);
      continue;
    }
    const manifest = readJson(manifestPath);
    if (!manifest) continue;

    if (manifest.name !== entry.packageName) {
      fail(
        `${entry.dir}/package.json 的 name 是 "${manifest.name}"，注册表写的是 "${entry.packageName}"。`,
      );
    }
    if (manifest.private !== true) {
      warn(`${entry.packageName} 未声明 "private": true。本仓库的包默认不发布。`);
    }

    const kinds = String(entry.kind ?? '')
      .split('+')
      .filter(Boolean);
    if (isPlugin(entry) && kinds.length === 0) {
      fail(`注册表条目 ${label} 的 kind 为空，应为 host、ui、mcp 的组合。`);
    }

    // host 半侧
    if (kinds.includes('host') || kinds.includes('mcp')) {
      const patchRel = manifest.dsh?.bundle?.patch;
      if (!patchRel) {
        fail(
          `${entry.packageName} 声明了 kind=${entry.kind}，但 package.json 缺少 dsh.bundle.patch。`,
        );
      } else {
        const patchPath = resolve(dir, patchRel);
        if (!existsSync(patchPath)) {
          fail(`${entry.packageName} 的 dsh.bundle.patch 指向不存在的文件：${patchRel}`);
        } else {
          const rows = parsePatchYaml(readFileSync(patchPath, 'utf8'), `${entry.dir}/${patchRel}`);
          if (rows) {
            if (rows.length === 0) fail(`${entry.dir}/${patchRel} 没有解析到任何行。`);
            const seen = new Set();
            for (const row of rows) {
              if (!row.id) {
                fail(`${entry.dir}/${patchRel} 有一行缺少 id：${row.raw.trim()}`);
                continue;
              }
              if (seen.has(row.id)) fail(`${entry.dir}/${patchRel} 的行 id 重复：${row.id}`);
              seen.add(row.id);
              if (!row.name && !row.raw.includes('insert')) {
                warn(`${entry.dir}/${patchRel} 的行 ${row.id} 没有声明 name。`);
              }
            }
          }
        }
      }
    }

    // ui 半侧
    if (kinds.includes('ui')) {
      if (!manifest.dsh?.client) {
        fail(`${entry.packageName} 声明了 kind=${entry.kind}，但 package.json 缺少 dsh.client。`);
      }
      const clientExport = manifest.exports?.['./client'];
      if (!clientExport) {
        fail(
          `${entry.packageName} 声明了 kind=${entry.kind}，但 package.json 缺少 "./client" 导出。`,
        );
      } else {
        const rel = typeof clientExport === 'string' ? clientExport : clientExport.default;
        if (rel && !existsSync(resolve(dir, rel))) {
          fail(`${entry.packageName} 的 "./client" 导出指向不存在的文件：${rel}`);
        }
      }
      const platform = manifest.dsh?.client?.platform;
      if (platform && platform !== 'web') {
        fail(`${entry.packageName} 的 dsh.client.platform 是 "${platform}"，本仓库只支持 "web"。`);
      }
    }

    // 产品规格文档
    for (const spec of entry.specs ?? []) {
      if (!existsSync(resolve(ROOT, spec))) {
        fail(`注册表条目 ${label} 声明的规格文档不存在：${spec}`);
      }
    }
  }

  // 反向检查：磁盘上有、注册表里没有的包
  for (const group of ['plugins', 'packages']) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const rel = `${group}/${name}`;
      const dir = join(groupDir, name);
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, 'package.json'))) continue;
      if (!registeredDirs.has(rel)) {
        fail(`${rel} 有 package.json，但没有登记在 plugins.json 中。`);
      }
    }
  }

  report();
}

function report() {
  for (const message of warnings) console.warn(`警告：${message}`);
  if (errors.length === 0) {
    console.log('清单校验通过：注册表与各包清单一致。');
    return;
  }
  console.error(`清单校验失败，共 ${errors.length} 个问题：\n`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exitCode = 1;
}

main();
