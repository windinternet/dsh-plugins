import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePsOutput, sampleProcessGroup } from '../src/metrics.js';
import { DockyardService } from '../src/service.js';

test('parsePsOutput：按进程组聚合 CPU 与 RSS，忽略无关进程', () => {
  const text = [
    '  100  100  12.5  2048',
    '  101  100   7.5  1024',
    '  200  200  99.0  8192',
    'garbage line',
  ].join('\n');
  const metrics = parsePsOutput(text, 100);
  assert.ok(metrics);
  assert.equal(metrics.cpuPercent, 20);
  assert.equal(metrics.rssBytes, 3072 * 1024);
  assert.equal(metrics.processCount, 2);
});

test('sampleProcessGroup：不支持的平台返回 null，不抛异常', async () => {
  assert.equal(await sampleProcessGroup(123, { platform: 'win32' }), null);
  assert.equal(await sampleProcessGroup(0, { platform: 'darwin' }), null);
});

test('服务采样：记录 CPU/内存、写入指标文件，并出现在 list 与项目汇总里', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-metrics-'));
  try {
    const service = new DockyardService({
      dataDir: dir,
      metricsIntervalMs: 0,
      syncIntervalMs: 0,
      autoTakeover: false,
      sampleProcessImpl: async () => ({
        cpuPercent: 12.5,
        rssBytes: 64 * 1024 * 1024,
        processCount: 2,
        at: 1_700_000_000_000,
      }),
    });
    await service.init();
    await service.add({
      id: 'app-1',
      name: 'app',
      dir: '/p',
      runner: 'node',
      command: 'node',
      args: ['server.js'],
      reason: 'test',
      projectId: 'project:/p',
      projectName: 'p',
      projectRoot: '/p',
      ecosystemId: 'node-npm',
      ecosystemName: 'Node.js (npm)',
      language: 'Node.js',
      manager: 'npm',
    });
    const record = service.store.get('app-1');
    assert.ok(record);
    record.status = 'running';
    record.startedAt = Date.now();
    service.processes.set('app-1', /** @type {any} */ ({ pid: process.pid }));

    await service.sampleMetricsNow();

    const list = await service.list();
    for (const value of Object.values(list[0] ?? {})) {
      assert.notEqual(value, undefined, 'list 输出不能含 undefined（工具要求 lossless JSON）');
    }
    assert.equal(list[0]?.cpuPercent, 12.5);
    assert.equal(list[0]?.rssBytes, 64 * 1024 * 1024);
    assert.equal(list[0]?.processCount, 2);

    const history = await service.getMetrics('app-1');
    assert.equal(history.source, 'memory');
    assert.equal(history.samples.length, 1);
    assert.equal(history.samples[0]?.cpuPercent, 12.5);

    const projects = await service.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.cpuPercent, 12.5);
    assert.equal(projects[0]?.running, 1);

    const files = await readdir(join(dir, 'metrics'));
    assert.equal(files.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
