import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanForApps,
  selectRunScripts,
  parsePackageJson,
  isIgnoredDir,
} from '../src/app-scanner.js';

/**
 * 在临时目录里搭一棵项目树，用完即删。不用仓库内的夹具，
 * 是为了让测试不依赖仓库状态，也不会在 git status 里留下噪音。
 *
 * @param {(root: string) => Promise<void>} build
 * @returns {Promise<import('../src/app-scanner.js').ScanResult>}
 */
async function withFixture(build) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-kit-scan-'));
  try {
    await build(root);
    return await scanForApps(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * 断言候选列表至少有一项，并返回首项。
 * @param {import('../src/app-scanner.js').AppCandidate[]} apps
 * @returns {import('../src/app-scanner.js').AppCandidate}
 */
function firstApp(apps) {
  const app = apps[0];
  assert.ok(app, '期望至少识别出一个候选应用');
  return /** @type {import('../src/app-scanner.js').AppCandidate} */ (app);
}

/**
 * 断言诊断列表至少有一项，并返回首项。
 * @param {import('../src/app-scanner.js').ScanDiagnostic[]} diagnostics
 * @returns {import('../src/app-scanner.js').ScanDiagnostic}
 */
function firstDiagnostic(diagnostics) {
  const item = diagnostics[0];
  assert.ok(item, '期望至少有一条诊断');
  return /** @type {import('../src/app-scanner.js').ScanDiagnostic} */ (item);
}

test('识别带 dev 脚本的 node 项目并给出判定理由', async () => {
  const result = await withFixture(async (root) => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'my-app', scripts: { dev: 'vite' } }),
    );
  });

  assert.equal(result.apps.length, 1);
  const app = firstApp(result.apps);
  assert.equal(app.runner, 'node');
  assert.equal(app.name, 'my-app');
  assert.equal(app.command, 'npm');
  assert.deepEqual(app.args, ['run', 'dev']);
  // 判定理由必须能指向具体依据，不能只说"看起来像"
  assert.match(app.reason, /package\.json 的 scripts\["dev"\]/);
  assert.match(app.reason, /"vite"/);
});

test('serve 与 start 也算可运行脚本', async () => {
  const result = await withFixture(async (root) => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { start: 'node server.js', 'serve:api': 'node api.js' } }),
    );
  });
  assert.equal(result.apps.length, 1);
  assert.ok(['start', 'serve:api'].includes(firstApp(result.apps).scriptName ?? ''));
});

test('不把 test/lint/build 之类的脚本当应用', async () => {
  const result = await withFixture(async (root) => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', build: 'tsc' } }),
    );
  });
  assert.equal(result.apps.length, 0);
});

test('package.json 非法时记录诊断而不是抛异常', async () => {
  const result = await withFixture(async (root) => {
    await writeFile(join(root, 'package.json'), '{ 这不是 JSON');
  });
  assert.equal(result.apps.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.match(firstDiagnostic(result.diagnostics).message, /不是合法 JSON/);
});

test('package.json 顶层是数组时被拒绝', async () => {
  const result = await withFixture(async (root) => {
    await writeFile(join(root, 'package.json'), '[1,2,3]');
  });
  assert.equal(result.apps.length, 0);
  assert.match(firstDiagnostic(result.diagnostics).message, /顶层不是对象/);
});

test('scripts 不是对象时忽略该字段并记录诊断', async () => {
  const result = await withFixture(async (root) => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: 'oops' }));
  });
  assert.equal(result.apps.length, 0);
  assert.match(firstDiagnostic(result.diagnostics).message, /scripts 不是对象/);
});

test('不进入 node_modules 与点目录', async () => {
  const result = await withFixture(async (root) => {
    for (const dir of ['node_modules', '.cache']) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, 'package.json'), JSON.stringify({ scripts: { dev: 'x' } }));
    }
  });
  assert.equal(result.apps.length, 0);
});

test('main.py 需要同目录有依赖声明才被认可', async () => {
  const withoutSignal = await withFixture(async (root) => {
    await writeFile(join(root, 'main.py'), 'print(1)');
  });
  assert.equal(withoutSignal.apps.length, 0);

  const withSignal = await withFixture(async (root) => {
    await writeFile(join(root, 'main.py'), 'print(1)');
    await writeFile(join(root, 'requirements.txt'), 'flask');
  });
  assert.equal(withSignal.apps.length, 1);
  assert.equal(firstApp(withSignal.apps).runner, 'python');
  assert.match(firstApp(withSignal.apps).reason, /requirements|依赖声明/);
});

test('manage.py 无需依赖声明即被识别为 Django 入口', async () => {
  const result = await withFixture(async (root) => {
    await writeFile(join(root, 'manage.py'), '#!/usr/bin/env python');
  });
  assert.equal(result.apps.length, 1);
  assert.deepEqual(result.apps[0]?.args, ['manage.py', 'runserver']);
});

test('scripts/ 下的可执行 shell 脚本被识别，不可执行的被忽略', async () => {
  const result = await withFixture(async (root) => {
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts', 'run.sh'), 'echo hi', { mode: 0o755 });
    await writeFile(join(root, 'scripts', 'helper.sh'), 'echo hi', { mode: 0o644 });
  });
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0]?.runner, 'shell');
  assert.match(result.apps[0]?.reason ?? '', /可执行权限/);
});

test('maxDepth 限制向下探索的层数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-kit-depth-'));
  try {
    const deep = join(root, 'a', 'b', 'c', 'd');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'package.json'), JSON.stringify({ scripts: { dev: 'x' } }));

    const shallow = await scanForApps(root, { maxDepth: 2 });
    assert.equal(shallow.apps.length, 0, '超过 maxDepth 的目录不应被扫描');

    const deepResult = await scanForApps(root, { maxDepth: 6 });
    assert.equal(deepResult.apps.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同一目录多个可运行脚本时只取首个，其余记为诊断', async () => {
  const result = await withFixture(async (root) => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'multi', scripts: { dev: 'vite', start: 'node .' } }),
    );
  });
  assert.equal(result.apps.length, 1);
  assert.ok(result.diagnostics.some((d) => /另有 1 个可运行脚本/.test(d.message)));
});

test('纯函数：selectRunScripts 与非对象输入', () => {
  assert.deepEqual(selectRunScripts({}), []);
  assert.deepEqual(selectRunScripts({ dev: '' }), []);
  assert.equal(selectRunScripts({ dev: 'vite' }).length, 1);
});

test('纯函数：isIgnoredDir', () => {
  assert.equal(isIgnoredDir('node_modules'), true);
  assert.equal(isIgnoredDir('.git'), true);
  assert.equal(isIgnoredDir('src'), false);
});

test('纯函数：parsePackageJson 对合法与非法输入的处理', () => {
  /** @type {{ path: string, message: string }[]} */
  const diagnostics = [];
  const ok = parsePackageJson('{"name":"a","scripts":{"dev":"x"}}', 'f', diagnostics);
  assert.equal(ok?.name, 'a');
  assert.deepEqual(diagnostics, []);
});
