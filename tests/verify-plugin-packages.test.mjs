import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findHostImports, stripComments } from '../scripts/verify-plugin-packages.mjs';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'verify-plugin-packages.mjs');

/**
 * 这些测试保护的是"升级事故的回归网"：检查脚本必须能抓住真实的宿主包导入，
 * 又不能被注释或字符串误导。误报会让检查失去可信度，漏报则会重演事故。
 */

test('findHostImports：静态 import / 动态 import / require 都能抓到', () => {
  const source = `
    import { defineTool } from '@deepseek-ai/dsh-tools';
    import z from "@deepseek-ai/schemastery";
    const lazy = await import('@deepseek-ai/dsh-tool-web');
    const legacy = require('@deepseek-ai/dsh-tools');
  `;
  assert.deepEqual(findHostImports(source).sort(), [
    '@deepseek-ai/dsh-tool-web',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/schemastery',
  ]);
});

test('findHostImports：注释里的包名不算导入（这正是误报的来源）', () => {
  const source = `
    // 不要写 import { x } from '@deepseek-ai/dsh-tools'
    /* 也不要 require('@deepseek-ai/schemastery') */
    const message = 'ok';
  `;
  assert.deepEqual(findHostImports(source), []);
});

test('findHostImports：字符串里出现 import 语法也不算（避免把提示文本当代码）', () => {
  const source = `
    const hint = "import x from '@deepseek-ai/dsh-tools'";
    const url = 'https://example.com/@deepseek-ai/dsh-tools';
  `;
  assert.deepEqual(findHostImports(source), []);
});

test('findHostImports：普通第三方依赖不误判', () => {
  const source = `import { z } from 'zod';\nimport ws from 'ws';`;
  assert.deepEqual(findHostImports(source), []);
});

test('stripComments：保留字符串内容，移除两类注释', () => {
  const source = `const a = 'keep // this';\n// drop me\nconst b = 1; /* drop me too */`;
  const stripped = stripComments(source);
  assert.match(stripped, /keep \/\/ this/);
  assert.doesNotMatch(stripped, /drop me/);
});

test('脚本直接运行：当前仓库通过', async () => {
  const { stdout } = await run(process.execPath, [SCRIPT], { cwd: ROOT });
  assert.match(stdout, /插件依赖边界检查通过/);
});

test('脚本直接运行：能对真实的坏清单报错并给出修复指令', async () => {
  // 造一个最小仓库骨架：注册表 + 一个违规插件包。
  const sandbox = await mkdtemp(join(tmpdir(), 'plugin-packages-check-'));
  try {
    await mkdir(join(sandbox, 'scripts'), { recursive: true });
    await mkdir(join(sandbox, 'plugins', 'bad'), { recursive: true });
    await writeFile(
      join(sandbox, 'plugins.json'),
      JSON.stringify({
        schemaVersion: 1,
        plugins: [{ id: 'bad', packageName: '@dsh-plugins/bad', dir: 'plugins/bad', specs: [] }],
        sharedPackages: [],
      }),
    );
    await writeFile(
      join(sandbox, 'plugins', 'bad', 'package.json'),
      JSON.stringify({
        name: '@dsh-plugins/bad',
        version: '0.1.0',
        dependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' },
      }),
    );
    await writeFile(
      join(sandbox, 'plugins', 'bad', 'index.js'),
      `import { defineTool } from '@deepseek-ai/dsh-tools';\nexport const name = 'bad';\n`,
    );

    // 用同一份脚本，但它按自身位置找 ROOT；这里复制过去以模拟真实目录结构。
    await writeFile(
      join(sandbox, 'scripts', 'verify-plugin-packages.mjs'),
      await (await import('node:fs/promises')).readFile(SCRIPT, 'utf8'),
    );

    await assert.rejects(
      () =>
        run(process.execPath, [join(sandbox, 'scripts', 'verify-plugin-packages.mjs')], {
          cwd: sandbox,
        }),
      (error) => {
        const stderr = String(error.stderr);
        assert.match(stderr, /声明了宿主包 @deepseek-ai\/dsh-tools/);
        assert.match(stderr, /导入了宿主包/);
        assert.match(stderr, /engines\.dsh/);
        assert.match(stderr, /修复：删除该依赖/);
        return true;
      },
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
