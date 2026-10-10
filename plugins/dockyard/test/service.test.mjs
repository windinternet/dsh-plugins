import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockyardService, candidateId, renderLogLines } from '../src/service.js';
import { parseState, emptyState, STATE_VERSION } from '../src/store.js';

/**
 * 这一组测试用真实子进程验证编排逻辑。
 * 项目扫描被替换成一个假的 scan，因此测试不依赖真实目录结构，
 * 也不会去扫本机的家目录——那既慢又不确定。
 */

/**
 * 造一个服务实例，扫描结果由传入的候选列表决定。
 * @param {string} dir 数据目录
 * @param {any[]} candidates 假扫描会返回的候选
 * @param {(message: string) => void} [onWarn]
 */
function makeService(dir, candidates, onWarn) {
  return new DockyardService({
    dataDir: dir,
    onWarn,
    scanImpl: async () => ({ apps: candidates, diagnostics: [], scannedDirs: candidates.length }),
  });
}

/**
 * 写一个能长期存活、并对 SIGTERM 优雅退出的子脚本。
 * @param {string} file
 */
async function writeLongRunning(file) {
  await writeFile(
    file,
    [
      "process.on('SIGTERM', () => process.exit(0));",
      "process.stdout.write('ready\\n');",
      "process.stderr.write('warn-line\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
}

/**
 * 从列表里取出指定 id 的条目并断言存在。
 * @param {any[]} list
 * @param {string} id
 * @returns {any}
 */
function pick(list, id) {
  const item = list.find((entry) => entry.id === id);
  assert.ok(item, `列表中应存在 id 为 ${id} 的条目`);
  return item;
}

/**
 * 断言启动成功并取出进程号。
 * @param {{ started: boolean, reason: string, pid?: number }} result
 * @returns {number}
 */
function startedPid(result) {
  assert.equal(result.started, true, result.reason);
  assert.ok(typeof result.pid === 'number' && result.pid > 0, '启动成功应带回进程号');
  return /** @type {number} */ (result.pid);
}

test('纯函数：candidateId 对同一项目稳定，对不同启动方式区分', () => {
  const a = candidateId({ dir: '/p', runner: 'node', scriptName: 'dev', args: ['run', 'dev'] });
  const b = candidateId({ dir: '/p', runner: 'node', scriptName: 'dev', args: ['run', 'dev'] });
  const c = candidateId({ dir: '/p', runner: 'node', scriptName: 'start', args: ['run', 'start'] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('纯函数：renderLogLines 标注输出来源', () => {
  const text = renderLogLines([
    { stream: 'stdout', at: Date.UTC(2026, 0, 1, 3, 4, 5), text: 'hello' },
    { stream: 'stderr', at: Date.UTC(2026, 0, 1, 3, 4, 6), text: 'boom' },
    { stream: 'system', at: Date.UTC(2026, 0, 1, 3, 4, 7), text: '已启动' },
  ]);
  assert.match(text, /OUT hello/);
  assert.match(text, /ERR boom/);
  assert.match(text, /SYS 已启动/);
});

test('parseState：坏输入被替换为安全默认并记录原因', () => {
  assert.deepEqual(parseState(null).state, emptyState());
  assert.match(parseState(null).problems.join('\n'), /顶层不是对象/);

  const bad = parseState({ version: STATE_VERSION, scanRoots: 'nope', applications: [] });
  assert.match(bad.problems.join('\n'), /scanRoots 不是数组/);
  assert.match(bad.problems.join('\n'), /applications 不是对象/);

  const partial = parseState({
    version: STATE_VERSION,
    applications: {
      ok: { dir: '/p', command: 'node', name: 'A', args: ['x'], status: 'running', runner: 'node' },
      broken: { name: 'B' },
      weird: { dir: '/q', command: 'node', status: '不存在的状态', args: 'no' },
    },
  });
  assert.ok(partial.state.applications.ok);
  assert.equal(partial.state.applications.broken, undefined);
  assert.match(partial.problems.join('\n'), /broken 缺少 dir 或 command/);
  // 未知状态降级为 unknown，非法 args 被丢弃
  const weird = partial.state.applications.weird;
  assert.ok(weird, 'weird 记录应被保留（字段被修正而不是整条丢弃）');
  assert.equal(weird.status, 'unknown');
  assert.deepEqual(weird.args, []);
});

test('parseState：更高版本的状态会提示未知字段被忽略', () => {
  const { problems } = parseState({ version: STATE_VERSION + 5, applications: {} });
  assert.match(problems.join('\n'), /高于本插件支持的/);
});

test('add 与 list：加入后可查到，重复加入被拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-add-'));
  try {
    const service = makeService(dir, []);
    await service.init();
    /** @type {Parameters<DockyardService['add']>[0]} */
    const candidate = {
      id: 'node:/p:dev',
      name: 'demo',
      dir: '/p',
      runner: 'node',
      command: 'node',
      args: ['-e', '1'],
      reason: 'package.json 的 scripts["dev"]',
    };
    assert.equal((await service.add(candidate)).added, true);
    assert.equal((await service.add(candidate)).added, false);
    const list = await service.list();
    assert.equal(list.length, 1);
    assert.equal(pick(list, 'node:/p:dev').status, 'stopped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('启动 → 状态为运行中且进程真实存在 → 停止后进程消失', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-life-'));
  try {
    const script = join(dir, 'child.mjs');
    await writeLongRunning(script);
    const service = makeService(dir, []);
    await service.init();
    await service.add({
      id: 'life',
      name: 'life',
      dir,
      runner: 'node',
      command: process.execPath,
      args: [script],
      reason: '测试夹具',
    });

    const started = await service.start('life');
    assert.equal(started.started, true);
    const pid = startedPid(started);

    const running = pick(await service.list(), 'life');
    assert.equal(running.status, 'running');
    assert.equal(running.pid, pid);
    assert.ok(running.uptimeMs >= 0);

    // 等子进程把启动日志写出来
    await new Promise((resolve) => setTimeout(resolve, 400));
    const logs = await service.logs('life', 50);
    assert.ok(logs.lines.length > 0, '应读到日志');
    assert.match(logs.lines.join('\n'), /ready/);

    const stopped = await service.stop('life');
    assert.equal(stopped.stopped, true);
    const after = pick(await service.list(), 'life');
    assert.equal(after.status, 'stopped');
    assert.equal(after.pid, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('进程自行退出时状态被更正为 crashed，而不是永久停在运行中', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-crash-'));
  try {
    const script = join(dir, 'die.mjs');
    await writeFile(script, 'process.stdout.write("bye\\n");\nprocess.exit(3);\n');
    const service = makeService(dir, []);
    await service.init();
    await service.add({
      id: 'die',
      name: 'die',
      dir,
      runner: 'node',
      command: process.execPath,
      args: [script],
      reason: '测试夹具',
    });

    await service.start('die');
    // 等退出事件回填状态
    await new Promise((resolve) => setTimeout(resolve, 600));
    const record = pick(await service.list(), 'die');
    assert.equal(record.status, 'crashed');
    assert.match(record.statusReason, /异常退出/);
    assert.equal(record.pid, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('运行中的应用不允许直接移除，停止后可以', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-rm-'));
  try {
    const script = join(dir, 'child.mjs');
    await writeLongRunning(script);
    const service = makeService(dir, []);
    await service.init();
    await service.add({
      id: 'rm',
      name: 'rm',
      dir,
      runner: 'node',
      command: process.execPath,
      args: [script],
      reason: '测试夹具',
    });
    await service.start('rm');
    const refused = await service.remove('rm');
    assert.equal(refused.removed, false);
    assert.match(refused.reason, /先停止/);

    await service.stop('rm');
    const removed = await service.remove('rm');
    assert.equal(removed.removed, true);
    assert.equal((await service.list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('重启会保留启动参数并给出新的进程号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-restart-'));
  try {
    const script = join(dir, 'child.mjs');
    await writeLongRunning(script);
    const service = makeService(dir, []);
    await service.init();
    await service.add({
      id: 'rs',
      name: 'rs',
      dir,
      runner: 'node',
      command: process.execPath,
      args: [script],
      reason: '测试夹具',
    });

    const first = await service.start('rs');
    const restarted = await service.restart('rs');
    assert.equal(restarted.restarted, true);
    const record = pick(await service.list(), 'rs');
    assert.equal(record.status, 'running');
    assert.notEqual(record.pid, startedPid(first), '重启后应是新的进程号');

    await service.stop('rs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('宿主重启后加载状态：running 被降级为 unknown，绝不谎报', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-reload-'));
  try {
    const script = join(dir, 'child.mjs');
    await writeLongRunning(script);
    const first = makeService(dir, []);
    await first.init();
    await first.add({
      id: 'persist',
      name: 'persist',
      dir,
      runner: 'node',
      command: process.execPath,
      args: [script],
      reason: '测试夹具',
    });
    await first.start('persist');
    assert.equal(pick(await first.list(), 'persist').status, 'running');

    // 不让它真的杀进程，避免留下孤儿；只验证"重新加载后的解释"
    /** @type {string[]} */
    const warnings = [];
    const second = makeService(dir, [], (m) => warnings.push(m));
    await second.init();
    const reloaded = await second.list();
    assert.equal(reloaded.length, 1);
    const reloadedRecord = pick(reloaded, 'persist');
    assert.equal(reloadedRecord.status, 'unknown');
    assert.match(reloadedRecord.statusReason, /宿主进程已重启/);
    assert.equal(reloadedRecord.pid, undefined);
    assert.deepEqual(warnings, []);

    // 收拾干净：用第一个实例停掉它
    await first.stop('persist');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('未知状态的记录可以被显式标记为已停止', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-unknown-'));
  try {
    const service = makeService(dir, []);
    await service.init();
    await service.add({
      id: 'ghost',
      name: 'ghost',
      dir: '/nowhere',
      runner: 'node',
      command: 'node',
      args: [],
      reason: '测试夹具',
    });
    // 手工制造"宿主重启后遗留"的状态
    const ghost = service.store.get('ghost');
    assert.ok(ghost, 'ghost 应已加入');
    ghost.status = 'unknown';
    const result = await service.stop('ghost');
    assert.equal(result.stopped, true);
    assert.equal(service.store.get('ghost')?.status, 'stopped');
    assert.match(result.reason, /无法回收非本进程启动的进程/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('状态文件损坏时给出诊断并重置，而不是让插件崩掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-corrupt-'));
  try {
    await writeFile(join(dir, 'state.json'), '{ 这不是 JSON');
    /** @type {string[]} */
    const warnings = [];
    const service = makeService(dir, [], (m) => warnings.push(m));
    await service.init();
    assert.equal((await service.list()).length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings.join('\n'), /不是合法 JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdown：默认不杀进程，但把状态如实标为 unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-shutdown-'));
  try {
    const script = join(dir, 'child.mjs');
    await writeLongRunning(script);
    const service = makeService(dir, []);
    await service.init();
    await service.add({
      id: 'kept',
      name: 'kept',
      dir,
      runner: 'node',
      command: process.execPath,
      args: [script],
      reason: '测试夹具',
    });
    const started = await service.start('kept');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await service.flushLogs();
    const result = await service.shutdown();
    assert.equal(result.killed, 0);
    assert.equal(result.leftRunning, 1);

    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.applications.kept.status, 'unknown');
    assert.match(state.applications.kept.statusReason, /插件已卸载/);

    // 自己收拾：直接杀进程，避免留下孤儿
    const keptPid = startedPid(started);
    try {
      process.kill(-keptPid, 'SIGKILL');
    } catch {
      try {
        process.kill(keptPid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdown：显式要求时停止被托管的进程', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-shutdown2-'));
  try {
    const script = join(dir, 'child.mjs');
    await writeLongRunning(script);
    const service = makeService(dir, []);
    await service.init();
    await service.add({
      id: 'killed',
      name: 'killed',
      dir,
      runner: 'node',
      command: process.execPath,
      args: [script],
      reason: '测试夹具',
    });
    const started = await service.start('killed');
    const killedPid = startedPid(started);
    const result = await service.shutdown({ killProcesses: true });
    assert.equal(result.killed, 1);
    assert.equal(result.leftRunning, 0);

    let alive = true;
    try {
      process.kill(killedPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, '显式要求停止后进程不应仍存在');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scan 会记住扫描根目录，并在候选上标记是否已托管', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-'));
  try {
    const candidate = {
      id: 'node:/p:dev',
      name: 'demo',
      dir: '/p',
      runner: 'node',
      command: 'node',
      args: ['-e', '1'],
      reason: 'package.json 的 scripts["dev"]',
    };
    const service = makeService(dir, [candidate]);
    await service.init();

    const first = await service.scan(['/p']);
    assert.equal(first.candidates.length, 1);
    const firstCandidate = first.candidates[0];
    assert.ok(firstCandidate, '应扫描出候选');
    assert.equal(firstCandidate.alreadyAdded, false);
    assert.deepEqual(service.store.state.scanRoots, ['/p']);

    await service.add(/** @type {any} */ (firstCandidate));
    const second = await service.scan(['/p']);
    assert.equal(second.candidates[0]?.alreadyAdded, true);
    // 重复扫描同一根目录不会重复记录
    assert.deepEqual(service.store.state.scanRoots, ['/p']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('停止不存在的应用与启动不存在的应用都给出可读原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-missing-'));
  try {
    const service = makeService(dir, []);
    await service.init();
    assert.match((await service.stop('nope')).reason, /没有 id 为 nope 的应用/);
    assert.match((await service.start('nope')).reason, /没有 id 为 nope 的应用/);
    assert.match((await service.remove('nope')).reason, /没有 id 为 nope 的应用/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
