import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLsofCwd,
  parseLsofPorts,
  isServiceLikeProcess,
  parsePsProcesses,
  terminateExternalProcess,
} from '../src/processes.js';

test('parsePsProcesses：解析 pid/父进程/进程组/CPU/RSS/命令', () => {
  const text = [
    '  100     1   100  12.5  2048 node server.js --port 3000',
    '  101   100   100   1.0  1024 sh -c child',
    'garbage',
  ].join('\n');
  const rows = parsePsProcesses(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    pid: 100,
    ppid: 1,
    pgid: 100,
    cpuPercent: 12.5,
    rssBytes: 2048 * 1024,
    command: 'node server.js --port 3000',
  });
});

test('parseLsofCwd / parseLsofPorts：按 pid 聚合 cwd 与监听端口', () => {
  const cwd = parseLsofCwd('p100\nfcwd\nn/Projects/a\np101\nfcwd\nn/Projects/b\n');
  assert.equal(cwd.get(100), '/Projects/a');
  assert.equal(cwd.get(101), '/Projects/b');

  const ports = parseLsofPorts('p100\nn*:3000\nn127.0.0.1:3001\np101\nn*:38501\n');
  assert.deepEqual(ports.get(100), [3000, 3001]);
  assert.deepEqual(ports.get(101), [38501]);
});

test('terminateExternalProcess：拒绝当前进程与系统进程', async () => {
  assert.equal((await terminateExternalProcess({ pid: 1, pgid: 1 })).stopped, false);
  assert.equal(
    (await terminateExternalProcess({ pid: process.pid, pgid: process.pid })).stopped,
    false,
  );
});

test('isServiceLikeProcess：排除终端/编辑器，保留服务启动器与监听端口的进程', () => {
  assert.equal(isServiceLikeProcess('node apps/admin-api/src/main.ts', []), true);
  assert.equal(isServiceLikeProcess('java -jar app.jar', []), true);
  assert.equal(isServiceLikeProcess('/bin/zsh -l', []), false);
  assert.equal(isServiceLikeProcess('Code Helper (Renderer)', []), false);
  assert.equal(isServiceLikeProcess('some-unknown --flag', [3000]), true);
  assert.equal(isServiceLikeProcess('some-unknown --flag', []), false);
});
