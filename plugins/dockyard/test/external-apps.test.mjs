import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectStopProcesses,
  matchExternalApps,
  scoreExternalProcess,
} from '../src/external-apps.js';

const nodeRecord = {
  id: 'node:/repo/web:dev',
  name: '@repo/web',
  dir: '/repo/web',
  command: 'pnpm',
  args: ['run', 'dev'],
  projectId: 'project:/repo',
  projectName: 'repo',
  projectRoot: '/repo',
};

const mavenRecords = [
  {
    id: 'maven:/repo:api',
    name: 'api',
    dir: '/repo',
    command: 'mvn',
    args: ['-pl', 'api', 'spring-boot:run'],
    projectId: 'project:/repo',
    projectName: 'repo',
    projectRoot: '/repo',
  },
  {
    id: 'maven:/repo:web',
    name: 'web',
    dir: '/repo',
    command: 'mvn',
    args: ['-pl', 'web', 'spring-boot:run'],
    projectId: 'project:/repo',
    projectName: 'repo',
    projectRoot: '/repo',
  },
];

test('匹配：cwd 与应用目录一致时归属明确', () => {
  const process = {
    pid: 10,
    ppid: 1,
    pgid: 10,
    cwd: '/repo/web',
    command: 'node /repo/web/server.js',
    cpuPercent: 3,
    rssBytes: 100,
    ports: [3000],
    root: '/repo',
  };
  assert.ok(scoreExternalProcess(process, nodeRecord) >= 100);
  const result = matchExternalApps([nodeRecord], [process]);
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0].id, nodeRecord.id);
  assert.deepEqual(result.apps[0].ports, [3000]);
  assert.equal(result.unmatched.length, 0);
});

test('匹配：Maven 多模块用 -pl 区分，cwd 相同也不歧义', () => {
  const process = {
    pid: 11,
    ppid: 1,
    pgid: 11,
    cwd: '/repo',
    command: 'mvn -pl api spring-boot:run',
    cpuPercent: 4,
    rssBytes: 200,
    ports: [8080],
    root: '/repo',
  };
  const result = matchExternalApps(mavenRecords, [process]);
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0].id, 'maven:/repo:api');
});

test('匹配：Maven 多模块没有模块选择时不猜，列为未识别', () => {
  const process = {
    pid: 12,
    ppid: 1,
    pgid: 12,
    cwd: '/repo',
    command: 'mvn spring-boot:run',
    cpuPercent: 4,
    rssBytes: 200,
    ports: [8080],
    root: '/repo',
  };
  const result = matchExternalApps(mavenRecords, [process]);
  assert.equal(result.apps.length, 0);
  assert.equal(result.unmatched.length, 1);
});

test('终止集合：包含项目内的父进程，避免被父进程重新拉起', () => {
  const parent = {
    pid: 20,
    ppid: 1,
    pgid: 20,
    cwd: '/repo',
    command: 'pnpm run dev',
  };
  const child = {
    pid: 21,
    ppid: 20,
    pgid: 20,
    cwd: '/repo/web',
    command: 'node server.js',
  };
  const stop = collectStopProcesses([child], [parent, child], '/repo');
  assert.deepEqual(
    stop.map((process) => process.pid).sort((a, b) => a - b),
    [20, 21],
  );
});
