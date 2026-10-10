#!/usr/bin/env node
/**
 * 把仓库自带的 .githooks 安装为当前克隆的 git 钩子。
 *
 * 为什么不用 husky：本仓库的钩子只有一个、逻辑也只有一行，引入一个 npm 依赖
 * 去管理它就过重了。core.hooksPath 是 git 原生能力，零依赖且行为可预期。
 *
 * 每个克隆执行一次即可（新克隆后运行 pnpm hooks:install）。
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = join(root, '.githooks');

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' });
} catch {
  console.error('当前目录不是 git 仓库，跳过钩子安装。');
  process.exit(0);
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });

// git 不会自动补可执行位；在 Windows 或新克隆上这一步是必要的。
for (const name of readdirSync(hooksDir)) {
  const file = join(hooksDir, name);
  if (!statSync(file).isFile()) continue;
  chmodSync(file, 0o755);
}

console.log('git 钩子已安装：core.hooksPath = .githooks');
console.log('钩子内容：pre-commit 执行 node scripts/check-secrets.mjs --staged');
