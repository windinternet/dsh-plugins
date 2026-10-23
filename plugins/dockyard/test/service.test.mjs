import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockyardService, candidateId, renderLogLines } from '../src/service.js';
import { parseState, emptyState, STATE_VERSION, StateStore } from '../src/store.js';

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
    metricsIntervalMs: 0,
    syncIntervalMs: 0,
    scanImpl: async () => ({
      projects: [
        {
          id: 'project:/p',
          name: 'p',
          root: '/p',
          source: 'manifest',
          container: null,
          ecosystems: [
            {
              id: 'node-npm',
              name: 'Node.js (npm)',
              language: 'Node.js',
              manager: 'npm',
              apps: candidates,
            },
          ],
          diagnostics: [],
        },
      ],
      diagnostics: [],
      scannedDirs: candidates.length,
    }),
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
  const parsedNull = parseState(null).state;
  const empty = emptyState();
  assert.deepEqual(
    { ...parsedNull, updatedAt: 0 },
    { ...empty, updatedAt: 0 },
    '除时间戳外应完全等于空状态',
  );
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

test('parseState：旧状态没有 preferences 时默认展示状态条', () => {
  const { state, problems } = parseState({ version: 3, applications: {} });
  assert.deepEqual(state.preferences, { statusBar: true });
  assert.deepEqual(problems, []);

  const bad = parseState({ version: STATE_VERSION, preferences: { statusBar: 'no' } });
  assert.equal(bad.state.preferences.statusBar, true);
  assert.match(bad.problems.join('\n'), /preferences\.statusBar 不是布尔值/);
});

test('状态条开关：默认展示，切换后持久化到状态文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-pref-'));
  try {
    const service = makeService(dir, []);
    await service.init();
    assert.equal(service.statusBarVisible, true);

    assert.deepEqual(await service.setStatusBarVisible(false), { visible: false });
    assert.equal(service.statusBarVisible, false);

    // 用同一目录新建实例，读到的必须是刚才写下的选择。
    const reloaded = makeService(dir, []);
    await reloaded.init();
    assert.equal(reloaded.statusBarVisible, false);

    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(raw.preferences, { statusBar: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    assert.equal(running.guard?.active, true, '手动启动应开启守护');
    assert.equal(running.guard?.attempts, 0);

    // 启动后的应用树不能被误判成外部进程，否则界面会在托管/非托管之间跳。
    const externalAfterStart = await service.listExternalApps({ fresh: true });
    assert.equal(
      externalAfterStart.apps.some((app) => app.id === 'life'),
      false,
      'dockyard 自己启动的应用不应出现在非托管列表里',
    );

    // 等子进程把启动日志写出来
    await new Promise((resolve) => setTimeout(resolve, 400));
    const logs = await service.logs('life', 50);
    assert.ok(logs.lines.length > 0, '应读到日志');
    const logText = logs.lines.join('\n');
    assert.match(logText, /OUT ready/);
    assert.match(logText, /ERR warn-line/);
    assert.match(logText, /SYS 已启动/);

    const stopped = await service.stop('life');
    assert.equal(stopped.stopped, true);
    const after = pick(await service.list(), 'life');
    assert.equal(after.status, 'stopped');
    assert.equal(after.pid, undefined);
    assert.equal(after.guard?.active, false, '手动停止应关闭守护');
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
    // 等被杀进程的日志写盘结束，再删目录；否则 rm 会偶发 ENOTEMPTY。
    await new Promise((resolve) => setTimeout(resolve, 100));
    await service.flushLogs();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    const firstApps = first.projects.flatMap((project) =>
      project.ecosystems.flatMap((group) => group.apps),
    );
    assert.equal(firstApps.length, 1);
    const firstCandidate = firstApps[0];
    assert.ok(firstCandidate, '应扫描出候选');
    assert.equal(firstCandidate.alreadyAdded, false);
    assert.deepEqual(service.store.state.scanRoots, ['/p']);

    await service.add(/** @type {any} */ (firstCandidate));
    const second = await service.scan(['/p']);
    const secondApps = second.projects.flatMap((project) =>
      project.ecosystems.flatMap((group) => group.apps),
    );
    assert.equal(secondApps[0]?.alreadyAdded, true);
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

test('addFromScan：重新扫描后只加入指定候选，找不到候选时给出原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-add-scan-'));
  try {
    const candidates = [
      {
        id: 'node:/p:dev',
        name: 'demo',
        dir: '/p',
        runner: 'node',
        command: 'node',
        scriptName: 'dev',
        args: ['server.js'],
        reason: 'package.json 的 scripts["dev"]',
      },
      {
        id: 'node:/q:start',
        name: 'other',
        dir: '/q',
        runner: 'node',
        command: 'node',
        scriptName: 'start',
        args: ['index.js'],
        reason: 'package.json 的 scripts["start"]',
      },
    ];
    const service = makeService(dir, candidates);
    await service.init();

    const added = await service.addFromScan('node:/p:dev', ['/p']);
    assert.equal(added.added, true, added.reason);
    assert.equal((await service.list()).length, 1);

    const missing = await service.addFromScan('node:/nope:x', ['/p']);
    assert.equal(missing.added, false);
    assert.match(missing.reason, /没有找到 id 为 node:\/nope:x 的候选应用/);

    // 已托管的候选再次加入会被拒绝，而不是产生重复条目。
    const duplicate = await service.addFromScan('node:/p:dev', ['/p']);
    assert.equal(duplicate.added, false);
    assert.match(duplicate.reason, /已在管理列表中/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('项目级托管：一次加入项目下全部应用，重复加入被跳过，可整项目移除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-project-'));
  try {
    const project = {
      id: 'project:/p',
      name: 'p',
      root: '/p',
      source: 'git',
      container: null,
      ecosystems: [
        {
          id: 'node-npm',
          name: 'Node.js (npm)',
          language: 'Node.js',
          manager: 'npm',
          apps: [
            {
              id: 'node:/p/a:dev',
              name: 'a',
              dir: '/p/a',
              runner: 'node',
              command: 'npm',
              args: ['run', 'dev'],
              reason: 'a',
              projectId: 'project:/p',
              projectName: 'p',
              projectRoot: '/p',
              ecosystemId: 'node-npm',
              ecosystemName: 'Node.js (npm)',
              language: 'Node.js',
              manager: 'npm',
            },
            {
              id: 'node:/p/b:dev',
              name: 'b',
              dir: '/p/b',
              runner: 'node',
              command: 'npm',
              args: ['run', 'dev'],
              reason: 'b',
              projectId: 'project:/p',
              projectName: 'p',
              projectRoot: '/p',
              ecosystemId: 'node-npm',
              ecosystemName: 'Node.js (npm)',
              language: 'Node.js',
              manager: 'npm',
            },
          ],
        },
      ],
      diagnostics: [],
    };
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      scanImpl: async () => ({
        projects: [/** @type {any} */ (project)],
        diagnostics: [],
        scannedDirs: 1,
      }),
    });
    await service.init();

    const first = await service.addProjectsFromScan(['project:/p'], ['/p']);
    assert.equal(first.added, true);
    assert.equal(first.appsAdded, 2);
    assert.equal((await service.list()).length, 2);

    const second = await service.addProjectsFromScan(['project:/p'], ['/p']);
    assert.equal(second.appsAdded, 0);
    assert.equal(second.skipped, 2);

    const removed = await service.removeProject('project:/p');
    assert.equal(removed.removed, true);
    assert.equal(removed.removedApps, 2);
    assert.equal((await service.list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('项目级托管：找不到项目时报告 missing，不误加别的应用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-project-missing-'));
  try {
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      scanImpl: async () => ({ projects: [], diagnostics: [], scannedDirs: 1 }),
    });
    await service.init();
    const result = await service.addProjectsFromScan(['project:/nope'], ['/p']);
    assert.equal(result.added, false);
    assert.deepEqual(result.missing, ['project:/nope']);
    assert.equal((await service.list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('外部进程接管：只停止匹配到的外部进程，再启动对应应用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-takeover-'));
  try {
    const project = {
      id: 'project:/p',
      name: 'p',
      root: dir,
      source: 'git',
      container: null,
      ecosystems: [
        {
          id: 'node-npm',
          name: 'Node.js (npm)',
          language: 'Node.js',
          manager: 'npm',
          apps: [
            {
              id: 'node:external:dev',
              name: 'external-app',
              dir,
              runner: 'node',
              command: process.execPath,
              args: ['-e', 'setInterval(() => {}, 1000);'],
              reason: 'test',
              projectId: 'project:/p',
              projectName: 'p',
              projectRoot: dir,
              ecosystemId: 'node-npm',
              ecosystemName: 'Node.js (npm)',
              language: 'Node.js',
              manager: 'npm',
            },
          ],
        },
      ],
      diagnostics: [],
    };
    /** @type {number[]} */
    /** @type {number[]} */
    const stoppedPids = [];
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      scanImpl: async () => ({
        projects: [/** @type {any} */ (project)],
        diagnostics: [],
        scannedDirs: 1,
      }),
      processLister: async () => ({
        processes: [
          {
            pid: 99999,
            ppid: 1,
            pgid: 99999,
            cpuPercent: 1,
            rssBytes: 1024,
            command: 'node apps/external',
            cwd: dir,
            ports: [3000],
            root: dir,
          },
        ],
        error: '',
      }),
      terminateImpl: async (item) => {
        stoppedPids.push(item.pid);
        return { stopped: true, reason: 'test' };
      },
    });
    await service.init();
    await service.addProject(/** @type {any} */ (project));

    const result = await service.takeoverProjectFromScan('project:/p');
    assert.equal(result.takenOver, 1, result.reason);
    assert.deepEqual(result.stoppedPids, [99999]);
    assert.equal(result.started.length, 1);
    assert.deepEqual(stoppedPids, [99999]);

    const apps = await service.list();
    assert.equal(apps.length, 1);
    assert.equal(apps[0]?.status, 'running');
    await service.stop(apps[0].id);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('周期同步：新增应用、命令变化保留旧参数、失联标记而不删除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-sync-'));
  try {
    /** @type {any[]} */
    let currentApps = [];
    /** @param {any[]} apps */
    const makeProject = (apps) => ({
      id: 'project:/p',
      name: 'p',
      root: '/p',
      source: 'git',
      container: null,
      ecosystems: [
        {
          id: 'node-npm',
          name: 'Node.js (npm)',
          language: 'Node.js',
          manager: 'npm',
          apps,
        },
      ],
      diagnostics: [],
    });
    /**
     * @param {string} id
     * @param {string} command
     * @param {string[]} args
     * @param {string} reason
     */
    const app = (id, command, args, reason) => ({
      id,
      name: id,
      dir: '/p',
      runner: 'node',
      command,
      args,
      reason,
      projectId: 'project:/p',
      projectName: 'p',
      projectRoot: '/p',
      ecosystemId: 'node-npm',
      ecosystemName: 'Node.js (npm)',
      language: 'Node.js',
      manager: 'npm',
    });

    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      syncOnStart: false,
      scanImpl: async () => ({
        projects: [/** @type {any} */ (makeProject(currentApps))],
        diagnostics: [],
        scannedDirs: 1,
      }),
    });
    await service.init();
    currentApps = [app('a', 'npm', ['run', 'dev'], 'old')];
    await service.add(/** @type {any} */ (currentApps[0]));

    // 新增 b，同时 a 的命令变化；a 处于运行态，应标记 restartRequired
    const recordA = service.store.get('a');
    assert.ok(recordA);
    recordA.status = 'running';
    currentApps = [app('a', 'pnpm', ['run', 'dev'], 'new'), app('b', 'npm', ['run', 'start'], 'b')];
    const first = await service.syncProjects();
    assert.equal(first.added, 1);
    assert.equal(first.changed, 1);
    const updatedA = service.store.get('a');
    assert.ok(updatedA);
    assert.equal(updatedA.command, 'pnpm');
    assert.equal(updatedA?.commandHistory?.length, 1);
    assert.equal(updatedA.commandHistory?.[0]?.command, 'npm');
    assert.equal(updatedA.restartRequired, true);
    assert.ok(service.store.get('b'));

    // b 从磁盘消失：标记 missing，记录仍在
    currentApps = [updatedA];
    const second = await service.syncProjects();
    assert.equal(second.missing, 1);
    assert.equal(service.store.get('b')?.missing, true);
    assert.ok(service.store.get('b'));

    // b 重新出现：清除 missing
    currentApps = [updatedA, app('b', 'npm', ['run', 'start'], 'b')];
    const third = await service.syncProjects();
    assert.equal(third.reappeared, 1);
    assert.equal(service.store.get('b')?.missing, false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('资源趋势：每轮采样后聚合运行中应用的 CPU/RSS 总量', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-resource-history-'));
  try {
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      scanImpl: async () => ({ projects: [], diagnostics: [], scannedDirs: 0 }),
    });
    await service.init();
    service.processes.set('a', /** @type {any} */ ({ pid: 111 }));
    service.processes.set('b', /** @type {any} */ ({ pid: 222 }));
    service.sampleProcessImpl = async (pid) => ({
      cpuPercent: pid === 111 ? 12.5 : 7.5,
      rssBytes: pid === 111 ? 500 : 300,
      processCount: 1,
      at: Date.now(),
    });

    await service.sampleMetricsNow();
    assert.equal(service.resourceHistory.length, 1);
    assert.equal(service.resourceHistory[0]?.cpuPercent, 20);
    assert.equal(service.resourceHistory[0]?.rssBytes, 800);
    assert.equal(service.resourceHistory[0]?.apps, 2);

    await service.sampleMetricsNow();
    assert.equal(service.resourceHistory.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('非托管应用可以被停止：只终止外部进程，不启动应用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-stop-external-'));
  try {
    const project = {
      id: 'project:/p',
      name: 'p',
      root: dir,
      source: 'git',
      container: null,
      ecosystems: [
        {
          id: 'node-npm',
          name: 'Node.js (npm)',
          language: 'Node.js',
          manager: 'npm',
          apps: [
            {
              id: 'node:external-stop:dev',
              name: 'external-stop',
              dir,
              runner: 'node',
              command: process.execPath,
              args: ['-e', 'setInterval(() => {}, 1000);'],
              reason: 'test',
              projectId: 'project:/p',
              projectName: 'p',
              projectRoot: dir,
              ecosystemId: 'node-npm',
              ecosystemName: 'Node.js (npm)',
              language: 'Node.js',
              manager: 'npm',
            },
          ],
        },
      ],
      diagnostics: [],
    };
    /** @type {number[]} */
    const stoppedPids = [];
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      scanImpl: async () => ({
        projects: [/** @type {any} */ (project)],
        diagnostics: [],
        scannedDirs: 1,
      }),
      processLister: async () => ({
        processes: [
          {
            pid: 88888,
            ppid: 1,
            pgid: 88888,
            cpuPercent: 1,
            rssBytes: 1024,
            command: 'node apps/external',
            cwd: dir,
            ports: [3000],
            root: dir,
          },
        ],
        error: '',
      }),
      terminateImpl: async (item) => {
        stoppedPids.push(item.pid);
        return { stopped: true, reason: 'test' };
      },
    });
    await service.init();
    await service.addProject(/** @type {any} */ (project));

    const result = await service.stop('node:external-stop:dev');
    assert.equal(result.stopped, true, result.reason);
    assert.deepEqual(stoppedPids, [88888]);
    const app = pick(await service.list(), 'node:external-stop:dev');
    assert.equal(app.status, 'stopped');
    assert.equal(app.pid, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('非托管应用重启等价于接管：停止外部进程后由 dockyard 启动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-restart-external-'));
  try {
    const project = {
      id: 'project:/p',
      name: 'p',
      root: dir,
      source: 'git',
      container: null,
      ecosystems: [
        {
          id: 'node-npm',
          name: 'Node.js (npm)',
          language: 'Node.js',
          manager: 'npm',
          apps: [
            {
              id: 'node:external-restart:dev',
              name: 'external-restart',
              dir,
              runner: 'node',
              command: process.execPath,
              args: ['-e', 'setInterval(() => {}, 1000);'],
              reason: 'test',
              projectId: 'project:/p',
              projectName: 'p',
              projectRoot: dir,
              ecosystemId: 'node-npm',
              ecosystemName: 'Node.js (npm)',
              language: 'Node.js',
              manager: 'npm',
            },
          ],
        },
      ],
      diagnostics: [],
    };
    /** @type {number[]} */
    const stoppedPids = [];
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      scanImpl: async () => ({
        projects: [/** @type {any} */ (project)],
        diagnostics: [],
        scannedDirs: 1,
      }),
      processLister: async () => ({
        processes: [
          {
            pid: 77777,
            ppid: 1,
            pgid: 77777,
            cpuPercent: 1,
            rssBytes: 1024,
            command: 'node apps/external',
            cwd: dir,
            ports: [3000],
            root: dir,
          },
        ],
        error: '',
      }),
      terminateImpl: async (item) => {
        stoppedPids.push(item.pid);
        return { stopped: true, reason: 'test' };
      },
    });
    await service.init();
    await service.addProject(/** @type {any} */ (project));

    const result = await service.restart('node:external-restart:dev');
    assert.equal(result.restarted, true, result.reason);
    assert.deepEqual(stoppedPids, [77777]);
    const app = pick(await service.list(), 'node:external-restart:dev');
    assert.equal(app.status, 'running');
    await service.stop('node:external-restart:dev');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('守护：崩溃后按退避重试，达到上限自动停止', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-guard-'));
  try {
    const script = join(dir, 'die.mjs');
    await writeFile(script, 'process.exit(1);\n');
    const project = {
      id: 'project:/p',
      name: 'p',
      root: dir,
      source: 'git',
      container: null,
      ecosystems: [
        {
          id: 'node-npm',
          name: 'Node.js (npm)',
          language: 'Node.js',
          manager: 'npm',
          apps: [
            {
              id: 'node:guard:dev',
              name: 'guarded-app',
              dir,
              runner: 'node',
              command: process.execPath,
              args: [script],
              reason: 'test',
              projectId: 'project:/p',
              projectName: 'p',
              projectRoot: dir,
              ecosystemId: 'node-npm',
              ecosystemName: 'Node.js (npm)',
              language: 'Node.js',
              manager: 'npm',
            },
          ],
        },
      ],
      diagnostics: [],
    };
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      scanImpl: async () => ({
        projects: [/** @type {any} */ (project)],
        diagnostics: [],
        scannedDirs: 1,
      }),
    });
    await service.init();
    await service.addProject(/** @type {any} */ (project));
    await service.setGuardPolicy({
      enabled: true,
      maxRetries: 2,
      backoffBaseMs: 500,
      backoffMaxMs: 500,
      resetAfterMs: 60000,
    });

    const started = await service.start('node:guard:dev');
    assert.equal(started.started, true);

    let app = pick(await service.list(), 'node:guard:dev');
    for (let index = 0; index < 80 && app.guard?.exhausted !== true; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      app = pick(await service.list(), 'node:guard:dev');
    }
    assert.equal(app.guard?.exhausted, true, '重试次数用尽后守护应停止');
    assert.equal(app.guard?.active, false);
    assert.equal(app.guard?.attempts, 2);
    assert.equal(app.status, 'crashed');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('守护：关闭保活策略后不自动重试', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-guard-off-'));
  try {
    const script = join(dir, 'die.mjs');
    await writeFile(script, 'process.exit(1);\n');
    const project = {
      id: 'project:/p',
      name: 'p',
      root: dir,
      source: 'git',
      container: null,
      ecosystems: [
        {
          id: 'node-npm',
          name: 'Node.js (npm)',
          language: 'Node.js',
          manager: 'npm',
          apps: [
            {
              id: 'node:guard-off:dev',
              name: 'unguarded-app',
              dir,
              runner: 'node',
              command: process.execPath,
              args: [script],
              reason: 'test',
              projectId: 'project:/p',
              projectName: 'p',
              projectRoot: dir,
              ecosystemId: 'node-npm',
              ecosystemName: 'Node.js (npm)',
              language: 'Node.js',
              manager: 'npm',
            },
          ],
        },
      ],
      diagnostics: [],
    };
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      scanImpl: async () => ({
        projects: [/** @type {any} */ (project)],
        diagnostics: [],
        scannedDirs: 1,
      }),
    });
    await service.init();
    await service.addProject(/** @type {any} */ (project));
    await service.setGuardPolicy({ enabled: false });

    await service.start('node:guard-off:dev');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const app = pick(await service.list(), 'node:guard-off:dev');
    assert.equal(app.guard?.active, false);
    assert.equal(app.guard?.attempts, 0);
    assert.equal(app.status, 'crashed');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('parseState：guardPolicy 越界时回退默认，guard 字段被保留', () => {
  const parsed = parseState({
    version: STATE_VERSION,
    guardPolicy: { enabled: false, maxRetries: 3, backoffBaseMs: 1000, backoffMaxMs: 9000 },
    applications: {
      a: {
        dir: '/p',
        command: 'node',
        status: 'crashed',
        logFile: '',
        guard: { active: true, attempts: 2, exhausted: false, reason: 'test' },
      },
    },
  });
  assert.equal(parsed.state.guardPolicy.enabled, false);
  assert.equal(parsed.state.guardPolicy.maxRetries, 3);
  assert.equal(parsed.state.applications.a?.guard?.active, true);
  assert.equal(parsed.state.applications.a?.guard?.attempts, 2);

  const bad = parseState({
    version: STATE_VERSION,
    guardPolicy: { maxRetries: 999, backoffBaseMs: 1 },
    applications: {},
  });
  assert.equal(bad.state.guardPolicy.maxRetries, 5);
  assert.ok(bad.problems.some((problem) => problem.includes('maxRetries')));
});

test('加载状态：宿主重启后暂停守护，绝不自动启动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-guard-load-'));
  try {
    const file = join(dir, 'state.json');
    await writeFile(
      file,
      JSON.stringify({
        version: STATE_VERSION,
        scanRoots: [],
        applications: {
          a: {
            id: 'a',
            name: 'a',
            dir: dir,
            runner: 'node',
            command: process.execPath,
            args: [],
            reason: 'test',
            status: 'running',
            logFile: join(dir, 'a.log'),
            addedAt: Date.now(),
            guard: { active: true, attempts: 3, reason: 'guarded before restart' },
          },
        },
        preferences: { statusBar: true },
        guardPolicy: {
          enabled: true,
          maxRetries: 5,
          backoffBaseMs: 2000,
          backoffMaxMs: 60000,
          resetAfterMs: 60000,
        },
      }),
    );
    const store = new StateStore(file);
    await store.load();
    const record = store.get('a');
    assert.equal(record?.status, 'unknown');
    assert.equal(record?.guard?.active, false);
    assert.equal(record?.guard?.nextAttemptAt, undefined);
    assert.match(record?.guard?.reason ?? '', /宿主重启/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('外部进程扫描：状态里仍运行的 pid 也会被排除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-managed-pids-'));
  try {
    /** @type {number[]} */
    let seenManagedPids = [];
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      processLister: async (/** @type {any} */ options) => {
        seenManagedPids = options.managedPids;
        return { processes: [], error: '' };
      },
    });
    await service.init();
    await service.add({
      id: 'node:managed-pid:dev',
      name: 'managed-pid',
      dir,
      runner: 'node',
      command: process.execPath,
      args: [],
      reason: 'test',
      projectId: 'project:/p',
      projectName: 'p',
      projectRoot: dir,
    });
    const record = service.store.get('node:managed-pid:dev');
    assert.ok(record);
    record.status = 'running';
    record.pid = 4242;

    await service.listExternalApps({ fresh: true });
    assert.ok(seenManagedPids.includes(4242), '状态里的运行 pid 必须传给外部进程扫描');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
