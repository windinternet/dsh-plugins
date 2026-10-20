import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  DEFAULT_PORT_RANGE,
  candidatePorts,
  isPortFree,
  normaliseVersion,
  parsePortRange,
  probeCdpEndpoint,
  selectFreePort,
  waitForCdpEndpoint,
} from '../src/ports.js';

/**
 * 端口选择是"自适应端口"这个承诺的落点：选错了要么启动失败，要么连上别人的调试端点。
 * 因此这里覆盖三类情况：配置解析（容错）、候选顺序（可预测）、探测证据（两级确认）。
 */

test('parsePortRange：接受数组、字符串与单端口，非法输入回退默认值', () => {
  assert.deepEqual(parsePortRange([24000, 24060]), { range: [24000, 24060], problem: null });
  assert.deepEqual(parsePortRange('24100-24110'), { range: [24100, 24110], problem: null });
  assert.deepEqual(parsePortRange('24200'), { range: [24200, 24200], problem: null });
  assert.deepEqual(parsePortRange(24300), { range: [24300, 24300], problem: null });
  assert.deepEqual(parsePortRange(undefined), { range: [...DEFAULT_PORT_RANGE], problem: null });

  // 非法输入不抛异常：配置写错不该让插件无法激活，而是回退并说明原因。
  const reversed = parsePortRange([24100, 24000]);
  assert.deepEqual(reversed.range, [...DEFAULT_PORT_RANGE]);
  assert.match(String(reversed.problem), /上界小于下界/);

  const outOfRange = parsePortRange([0, 70000]);
  assert.deepEqual(outOfRange.range, [...DEFAULT_PORT_RANGE]);
  assert.match(String(outOfRange.problem), /非法端口/);

  const wrongType = parsePortRange({ lo: 1 });
  assert.deepEqual(wrongType.range, [...DEFAULT_PORT_RANGE]);
  assert.match(String(wrongType.problem), /不受支持/);
});

test('candidatePorts：优先尝试偏好端口，且不重复', () => {
  assert.deepEqual(candidatePorts([24000, 24003], 24002), [24002, 24000, 24001, 24003]);
  // 偏好端口不在范围内时忽略它，而不是擅自越界尝试。
  assert.deepEqual(candidatePorts([24000, 24002], 9999), [24000, 24001, 24002]);
  assert.deepEqual(candidatePorts([24000, 24000], undefined), [24000]);
});

test('isPortFree：空闲端口为 true，被占用为 false', async () => {
  const server = createServer();
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  assert.ok(port > 0);
  assert.equal(await isPortFree(port), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortFree(port), true);
});

test('normaliseVersion：不信任响应字段，缺失时给出 unknown 而不是 undefined', () => {
  const version = normaliseVersion({
    Browser: 'Chrome/155.0.8059.40',
    'Protocol-Version': '1.3',
    webSocketDebuggerUrl: 'ws://127.0.0.1:24000/devtools/browser/abc',
  });
  assert.equal(version.browser, 'Chrome/155.0.8059.40');
  assert.equal(version.protocolVersion, '1.3');
  assert.equal(version.userAgent, '');

  const partial = normaliseVersion({ webSocketDebuggerUrl: 'ws://x/y' });
  assert.equal(partial.browser, 'unknown');
  assert.equal(partial.protocolVersion, 'unknown');
});

test('probeCdpEndpoint：区分「不是调试端点」与「连不上」', async () => {
  const notDevtools = await probeCdpEndpoint(24000, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ hello: 'world' }) }),
  });
  assert.equal(notDevtools.ok, false);
  assert.match(String(notDevtools.reason), /webSocketDebuggerUrl/);

  const httpError = await probeCdpEndpoint(24000, {
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(httpError.ok, false);
  assert.match(String(httpError.reason), /HTTP 404/);

  const unreachable = await probeCdpEndpoint(24000, {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(unreachable.ok, false);
  assert.match(String(unreachable.reason), /ECONNREFUSED/);

  const good = await probeCdpEndpoint(24000, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ Browser: 'Chromium/1', webSocketDebuggerUrl: 'ws://127.0.0.1:1/x' }),
    }),
  });
  assert.equal(good.ok, true);
});

test('waitForCdpEndpoint：先失败后成功时返回等待耗时', async () => {
  let calls = 0;
  const result = await waitForCdpEndpoint(24000, {
    timeoutMs: 2000,
    intervalMs: 1,
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error('not up yet');
      return {
        ok: true,
        json: async () => ({ Browser: 'Chromium/1', webSocketDebuggerUrl: 'ws://x' }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test('waitForCdpEndpoint：始终失败时超时并带出最后一次原因', async () => {
  const result = await waitForCdpEndpoint(24000, {
    timeoutMs: 5,
    intervalMs: 1,
    sleep: async () => {},
    fetchImpl: async () => {
      throw new Error('nope');
    },
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /nope/);
});

test('selectFreePort：跳过已有调试端点的端口，返回第一个既空闲又无端点的端口', async () => {
  const probed = [];
  const result = await selectFreePort({
    range: [24000, 24005],
    isFree: async () => true,
    hasEndpoint: async (port) => {
      probed.push(port);
      return port === 24000 || port === 24001;
    },
  });
  assert.equal(result.port, 24002);
  assert.equal(result.skipped, 2);
  assert.deepEqual(probed, [24000, 24001, 24002]);
});

test('selectFreePort：优先复用偏好端口（避免端口漂移）', async () => {
  const result = await selectFreePort({
    range: [24000, 24005],
    preferred: 24003,
    isFree: async () => true,
    hasEndpoint: async () => false,
  });
  assert.equal(result.port, 24003);
});

test('selectFreePort：范围内全不可用时明确失败，不越界选端口', async () => {
  const result = await selectFreePort({
    range: [24000, 24002],
    isFree: async () => false,
    hasEndpoint: async () => false,
  });
  assert.equal(result.port, 0);
  assert.match(String(result.reason), /24000-24002/);
});
