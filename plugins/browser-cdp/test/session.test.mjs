import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpConnection, CdpError, CdpClosedError, parseFrame } from '../src/cdp.js';
import {
  consoleLevelOf,
  describeKey,
  describeRemoteObject,
  messageOf,
  modifierMask,
  normaliseUrl,
} from '../src/session.js';

/**
 * 这一组测试覆盖"不需要浏览器"的部分：协议帧解析、按键编码、URL 规范化。
 *
 * 它们看起来琐碎，但都是实际会出错的地方：帧解析错一次会让所有命令静默超时；
 * 修饰位算错会让 Cmd+A 变成输入一个 "a"；URL 补全错会让 example.com 变成一条
 * 无法诊断的导航失败。
 */

test('parseFrame：区分响应、事件与垃圾输入', () => {
  assert.deepEqual(parseFrame('{"id":1,"result":{"ok":true}}'), {
    kind: 'response',
    id: 1,
    result: { ok: true },
    error: undefined,
    sessionId: undefined,
  });
  assert.deepEqual(parseFrame('{"method":"Page.loadEventFired","params":{},"sessionId":"s1"}'), {
    kind: 'event',
    method: 'Page.loadEventFired',
    params: {},
    sessionId: 's1',
  });
  // 畸形输入一律返回 null，由调用方决定忽略——绝不让它打崩监听器
  assert.equal(parseFrame('not json'), null);
  assert.equal(parseFrame('[1,2,3]'), null);
  assert.equal(parseFrame('null'), null);
  assert.equal(parseFrame('{"foo":"bar"}'), null);
  assert.equal(parseFrame(undefined), null);
  assert.equal(parseFrame(42), null);
});

test('parseFrame：事件缺失 params 时补成空对象，避免下游 undefined 崩溃', () => {
  const frame = parseFrame('{"method":"X","sessionId":"s"}');
  assert.equal(frame?.kind, 'event');
  assert.deepEqual(frame?.params, {});
});

test('CdpError：保留 code 与 data（调用方要靠 code 区分错误类型）', () => {
  const error = new CdpError('Runtime.evaluate', {
    code: -32000,
    message: 'Cannot find context',
    data: 'x',
  });
  assert.equal(error.code, -32000);
  assert.equal(error.data, 'x');
  assert.match(error.message, /CDP Runtime\.evaluate 失败/);
  assert.match(error.message, /code -32000/);
  assert.ok(error instanceof Error);
});

test('CdpClosedError：名字固定，便于上层识别"该重连了"', () => {
  const error = new CdpClosedError('断了');
  assert.equal(error.name, 'CdpClosedError');
  assert.equal(error.message, '断了');
});

test('normaliseUrl：补 scheme，保留已有 scheme', () => {
  assert.equal(normaliseUrl('example.com'), 'https://example.com');
  assert.equal(normaliseUrl('  example.com/a?b=1 '), 'https://example.com/a?b=1');
  assert.equal(normaliseUrl('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(normaliseUrl('about:blank'), 'about:blank');
  assert.equal(normaliseUrl('data:text/html,<h1>x</h1>'), 'data:text/html,<h1>x</h1>');
  assert.throws(() => normaliseUrl('   '), /URL 不能为空/);
});

test('modifierMask：按 CDP 的位定义编码修饰键', () => {
  assert.equal(modifierMask([]), 0);
  assert.equal(modifierMask(['Alt']), 1);
  assert.equal(modifierMask(['Ctrl']), 2);
  assert.equal(modifierMask(['Meta']), 4);
  assert.equal(modifierMask(['Shift']), 8);
  assert.equal(modifierMask(['Meta', 'Shift']), 12);
  assert.equal(modifierMask(['cmd']), 4);
  assert.throws(() => modifierMask(['Hyper']), /不支持的修饰键/);
});

test('describeKey：具名键带正确 keyCode，回车带文本', () => {
  const enter = describeKey('Enter', []);
  assert.equal(enter.key, 'Enter');
  assert.equal(enter.code, 'Enter');
  assert.equal(enter.windowsVirtualKeyCode, 13);
  assert.equal(enter.text, '\r');

  const tab = describeKey('Tab', ['Shift']);
  assert.equal(tab.windowsVirtualKeyCode, 9);
  assert.equal(tab.modifiers, 8);
  assert.equal(tab.text, undefined);

  const arrow = describeKey('ArrowDown', []);
  assert.equal(arrow.windowsVirtualKeyCode, 40);
});

test('describeKey：单字符键映射成 KeyX，未知键名明确报错', () => {
  const a = describeKey('a', ['Meta']);
  assert.equal(a.code, 'KeyA');
  assert.equal(a.modifiers, 4);
  assert.equal(a.text, 'a');

  const upper = describeKey('A', []);
  assert.equal(upper.code, 'KeyA');
  // 单字符键必须带 text，否则浏览器收不到字符输入
  assert.equal(upper.text, 'A');

  assert.throws(() => describeKey('F13', []), /不支持的按键/);
});

test('describeRemoteObject：console 参数投影成一行文本', () => {
  assert.equal(describeRemoteObject('plain'), 'plain');
  assert.equal(describeRemoteObject({ value: 'text' }), 'text');
  assert.equal(describeRemoteObject({ value: { a: 1 } }), '{"a":1}');
  assert.equal(
    describeRemoteObject({ type: 'function', description: 'function f()' }),
    'function f()',
  );
  assert.equal(describeRemoteObject({ type: 'undefined' }), 'undefined');
  assert.equal(describeRemoteObject(null), 'null');
});

test('consoleLevelOf：把 CDP 的 console 类型收敛成四级', () => {
  assert.equal(consoleLevelOf('error'), 'error');
  assert.equal(consoleLevelOf('assert'), 'error');
  assert.equal(consoleLevelOf('warning'), 'warning');
  assert.equal(consoleLevelOf('warn'), 'warning');
  assert.equal(consoleLevelOf('debug'), 'debug');
  assert.equal(consoleLevelOf('trace'), 'debug');
  assert.equal(consoleLevelOf('log'), 'info');
  assert.equal(consoleLevelOf('随便什么'), 'info');
});

test('messageOf：非 Error 输入也要给出可读文本', () => {
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf('plain'), 'plain');
  assert.equal(messageOf({ a: 1 }), '[object Object]');
});

test('CdpConnection：没有可用 socket 时 send 立即拒绝，不挂起', async () => {
  /** 一个最小的假 WebSocket：记录发送内容，能把消息回调回去。 */
  const listeners = new Map();
  const sent = [];
  const socket = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    close() {
      listeners.get('close')?.();
    },
  };
  const connection = new CdpConnection(/** @type {any} */ (socket), { commandTimeoutMs: 50 });
  const promise = connection.send('Runtime.evaluate', { expression: '1' }, { sessionId: 's1' });
  assert.equal(sent[0].method, 'Runtime.evaluate');
  assert.equal(sent[0].sessionId, 's1');

  // 模拟浏览器回帧
  listeners.get('message')({
    data: JSON.stringify({ id: sent[0].id, result: { value: 1 }, sessionId: 's1' }),
  });
  assert.deepEqual(await promise, { value: 1 });

  // 关闭后立即拒绝，且不再尝试发送
  connection.close();
  await assert.rejects(() => connection.send('X'), /已关闭/);
  assert.equal(sent.length, 1);
});

test('CdpConnection：错误响应变成 CdpError，超时也变成 CdpError', async () => {
  const listeners = new Map();
  const sent = [];
  const socket = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    close() {},
  };
  const connection = new CdpConnection(/** @type {any} */ (socket), { commandTimeoutMs: 30 });

  const failing = connection.send('Page.navigate', {});
  listeners.get('message')({
    data: JSON.stringify({ id: sent[0].id, error: { code: -32000, message: 'nope' } }),
  });
  await assert.rejects(() => failing, /nope/);

  await assert.rejects(() => connection.send('Page.navigate', {}), /没有返回/);
});

test('CdpConnection：事件分发给所有订阅者，一个抛异常不影响其它订阅者', () => {
  const listeners = new Map();
  const socket = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    send() {},
    close() {},
  };
  const connection = new CdpConnection(/** @type {any} */ (socket));
  const seen = [];
  connection.on(() => {
    throw new Error('这个订阅者坏了');
  });
  connection.on((event) => seen.push(event.method));

  listeners.get('message')({
    data: JSON.stringify({ method: 'Page.loadEventFired', params: { a: 1 }, sessionId: 's' }),
  });
  assert.deepEqual(seen, ['Page.loadEventFired']);

  // 退订之后不该再收到事件（这正是 disposer 的语义）
  const unsubscribe = connection.on((event) => seen.push(`2:${event.method}`));
  unsubscribe();
  seen.length = 0;
  listeners.get('message')({ data: JSON.stringify({ method: 'Page.frameNavigated', params: {} }) });
  assert.deepEqual(seen, ['Page.frameNavigated']);
});
