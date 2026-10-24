import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ACTION_HEADER,
  createDockyardHandlers,
  isLoopback,
  normalizeLogLines,
  normalizeRoots,
} from '../src/http.js';

/**
 * 这一组测试只覆盖 HTTP 这一层：鉴权边界、参数归一化、错误码与动作分发。
 * 真正的进程与日志行为在 service.test.mjs 里用真实子进程验证。
 */

/**
 * 造一个记录调用的假服务。没被覆盖的方法都返回可预期的固定值。
 */
function makeService(overrides = {}) {
  /** @type {any[]} */
  const calls = [];
  const service = {
    calls,
    store: { state: { scanRoots: ['/work'] }, problems: [] },
    statusBarVisible: true,
    setStatusBarVisible: async (/** @type {boolean} */ visible) => {
      calls.push(['setStatusBarVisible', visible]);
      return { visible };
    },
    list: async () => [{ id: 'a', name: 'A', status: 'running' }],
    listProjects: async () => [{ id: 'project:/a', name: 'A', apps: 1, running: 1 }],
    systemSnapshot: () => ({ totalmem: 1, freemem: 1, cpus: 1, loadavg: [0, 0, 0], uptime: 1 }),
    resourceHistory: [{ at: 1, cpuPercent: 2, rssBytes: 3, apps: 1 }],
    lastSync: null,
    syncIntervalMs: 0,
    syncProjects: async () => {
      calls.push(['syncProjects']);
      return {
        at: 1,
        durationMs: 1,
        projects: 1,
        added: 0,
        changed: 0,
        missing: 0,
        reappeared: 0,
        errors: 0,
      };
    },
    logs: async (/** @type {string} */ id, /** @type {number} */ lines) => {
      calls.push(['logs', id, lines]);
      return { lines: [`line for ${id}`], source: 'buffer' };
    },
    start: async (/** @type {string} */ id) => {
      calls.push(['start', id]);
      return { started: true, reason: `started ${id}`, pid: 4242 };
    },
    stop: async (/** @type {string} */ id) => {
      calls.push(['stop', id]);
      return { stopped: true, reason: `stopped ${id}` };
    },
    restart: async (/** @type {string} */ id) => {
      calls.push(['restart', id]);
      return { restarted: true, reason: `restarted ${id}` };
    },
    remove: async (/** @type {string} */ id) => {
      calls.push(['remove', id]);
      return { removed: true, reason: `removed ${id}` };
    },
    scan: async (/** @type {string[]} */ roots, /** @type {any} */ options) => {
      calls.push(['scan', roots, options]);
      return { candidates: [{ id: 'candidate-1' }], diagnostics: [], scannedDirs: roots.length };
    },
    addFromScan: async (/** @type {string} */ candidateId, /** @type {string[]} */ roots) => {
      calls.push(['addFromScan', candidateId, roots]);
      return { added: true, reason: `added ${candidateId}` };
    },
    addProjectsFromScan: async (
      /** @type {string[]} */ projectIds,
      /** @type {string[]} */ roots,
    ) => {
      calls.push(['addProjectsFromScan', projectIds, roots]);
      return {
        added: true,
        projectIds,
        appsAdded: projectIds.length,
        skipped: 0,
        missing: [],
        reason: 'ok',
      };
    },
    removeProject: async (/** @type {string} */ projectId) => {
      calls.push(['removeProject', projectId]);
      return { removed: true, removedApps: 1, reason: 'ok' };
    },
    externalProcesses: async (/** @type {string[]|undefined} */ roots) => {
      calls.push(['externalProcesses', roots]);
      return {
        processes: [
          {
            pid: 123,
            ppid: 1,
            pgid: 123,
            cpuPercent: 1,
            rssBytes: 1024,
            command: 'node app',
            cwd: '/work/a',
            ports: [3000],
            root: '/work/a',
          },
        ],
        error: '',
      };
    },
    listExternalApps: async () => {
      calls.push(['listExternalApps']);
      return {
        apps: [
          {
            id: 'a',
            name: 'A',
            projectId: 'project:/work/a',
            projectName: 'A',
            projectRoot: '/work/a',
            dir: '/work/a',
            managed: false,
            status: 'running',
            cpuPercent: 1,
            rssBytes: 1024,
            pids: [123],
            ports: [3000],
            processes: [{ pid: 123 }],
            stopProcesses: [{ pid: 123 }],
          },
        ],
        unmatched: 0,
        error: '',
      };
    },
    takeoverApp: async (/** @type {string} */ id) => {
      calls.push(['takeoverApp', id]);
      return { takenOver: 1, started: [id], failed: [], skipped: [], reason: 'ok' };
    },
    takeoverProject: async (/** @type {string} */ projectId) => {
      calls.push(['takeoverProject', projectId]);
      return { takenOver: 1, started: ['a'], failed: [], skipped: [], reason: 'ok' };
    },
    takeoverAll: async () => {
      calls.push(['takeoverAll']);
      return { takenOver: 1, started: ['a'], failed: [], skipped: [], reason: 'ok' };
    },
    guardPolicy: {
      enabled: true,
      maxRetries: 5,
      backoffBaseMs: 2000,
      backoffMaxMs: 60000,
      resetAfterMs: 60000,
    },
    setAppPreferredPort: async (/** @type {string} */ id, /** @type {number} */ port) => {
      calls.push(['setAppPreferredPort', id, port]);
      return { id, port };
    },
    setGuardPolicy: async (/** @type {any} */ patch) => {
      if (typeof patch.enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值。');
      calls.push(['setGuardPolicy', patch]);
      return { ...service.guardPolicy, ...patch };
    },
  };
  return Object.assign(service, overrides);
}

/**
 * 造一个最小可用的 IncomingMessage：请求体是一个可读流，其余字段直接挂上去。
 * @param {{ method?: string, url?: string, headers?: Record<string, string>, body?: unknown, remote?: string }} [options]
 */
function makeReq({ method = 'GET', url = '/', headers = {}, body, remote = '127.0.0.1' } = {}) {
  const chunks =
    body === undefined
      ? []
      : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
  const req = Readable.from(chunks);
  return /** @type {any} */ (
    Object.assign(req, {
      method,
      url,
      headers,
      socket: { remoteAddress: remote },
    })
  );
}

/** 造一个只记录状态码、响应头与响应体的假 ServerResponse。 */
function makeRes() {
  return {
    statusCode: 0,
    /** @type {Record<string, string>} */
    headers: {},
    body: '',
    /**
     * @param {number} code
     * @param {Record<string, string>} [headers]
     */
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
    },
    /**
     * @param {string} name
     * @param {string} value
     */
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    /** @param {string} [chunk] */
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

/** 带完整动作头的 JSON 请求头。 */
const ACTION_HEADERS = {
  'content-type': 'application/json',
  [ACTION_HEADER]: '1',
  host: '127.0.0.1:4567',
};

test('isLoopback：只认回环地址的三种写法', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.9'), false);
  assert.equal(isLoopback(''), false);
  assert.equal(isLoopback(undefined), false);
});

test('normalizeRoots：展开家目录、去重，并拒绝相对路径', () => {
  assert.deepEqual(normalizeRoots([' ~ ', '~/work', '~/work']), [
    homedir(),
    join(homedir(), 'work'),
  ]);
  assert.throws(() => normalizeRoots(['relative/path']), /必须是绝对路径/);
  assert.throws(() => normalizeRoots([]), /至少需要一个扫描根目录/);
  assert.throws(() => normalizeRoots(['/a', 3]), /必须是字符串/);
});

test('normalizeLogLines：非法值回退默认，越界被夹住', () => {
  assert.equal(normalizeLogLines(undefined), 200);
  assert.equal(normalizeLogLines('nope'), 200);
  assert.equal(normalizeLogLines(0), 1);
  assert.equal(normalizeLogLines(99999), 2000);
  assert.equal(normalizeLogLines('300'), 300);
});

test('status：返回应用、扫描根目录与诊断，且不带 CORS 头', async () => {
  const handlers = createDockyardHandlers(/** @type {any} */ (makeService()));
  const res = makeRes();
  await handlers.status(makeReq(), /** @type {any} */ (res));
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.applications.length, 1);
  assert.deepEqual(body.scanRoots, ['/work']);
  assert.deepEqual(body.warnings, []);
  assert.deepEqual(body.preferences, { statusBar: true });
  assert.deepEqual(body.resourceHistory, [{ at: 1, cpuPercent: 2, rssBytes: 3, apps: 1 }]);
  assert.equal(body.externalApps.length, 1);
  assert.equal(body.externalApps[0].id, 'a');
  assert.equal(body.externalApps[0].processes, undefined);
  assert.equal(body.externalUnmatched, 0);
  assert.equal(body.guardPolicy.maxRetries, 5);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('status：非回环来源直接 403', async () => {
  const handlers = createDockyardHandlers(/** @type {any} */ (makeService()));
  const res = makeRes();
  await handlers.status(makeReq({ remote: '10.0.0.8' }), /** @type {any} */ (res));
  assert.equal(res.statusCode, 403);
});

test('status：非 GET 返回 405', async () => {
  const handlers = createDockyardHandlers(/** @type {any} */ (makeService()));
  const res = makeRes();
  await handlers.status(makeReq({ method: 'POST' }), /** @type {any} */ (res));
  assert.equal(res.statusCode, 405);
});

test('logs：缺少 id 时 400；行数被夹到上限', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));

  const missing = makeRes();
  await handlers.logs(makeReq({ url: '/plugin/dockyard/logs' }), /** @type {any} */ (missing));
  assert.equal(missing.statusCode, 400);

  const ok = makeRes();
  await handlers.logs(
    makeReq({ url: '/plugin/dockyard/logs?id=a&lines=99999' }),
    /** @type {any} */ (ok),
  );
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['logs', 'a', 2000]);
});

test('action：非 POST、缺自定义头、错 content-type、跨源 Origin 都被拒绝', async () => {
  const handlers = createDockyardHandlers(/** @type {any} */ (makeService()));

  const getRes = makeRes();
  await handlers.action(
    makeReq({ method: 'GET', headers: ACTION_HEADERS }),
    /** @type {any} */ (getRes),
  );
  assert.equal(getRes.statusCode, 405);

  const noHeader = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4567' },
      body: { action: 'start', id: 'a' },
    }),
    /** @type {any} */ (noHeader),
  );
  assert.equal(noHeader.statusCode, 403);

  const wrongType = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: { ...ACTION_HEADERS, 'content-type': 'text/plain' },
      body: '{}',
    }),
    /** @type {any} */ (wrongType),
  );
  assert.equal(wrongType.statusCode, 415);

  const foreignOrigin = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: { ...ACTION_HEADERS, origin: 'http://evil.example' },
      body: { action: 'start', id: 'a' },
    }),
    /** @type {any} */ (foreignOrigin),
  );
  assert.equal(foreignOrigin.statusCode, 403);
});

test('action：start 交给服务层并原样返回结果', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));
  const res = makeRes();
  await handlers.action(
    makeReq({ method: 'POST', headers: ACTION_HEADERS, body: { action: 'start', id: 'a' } }),
    /** @type {any} */ (res),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['start', 'a']);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.action, 'start');
  assert.equal(body.result.started, true);
});

test('action：同源 Origin 被接受', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));
  const res = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: { ...ACTION_HEADERS, origin: 'http://127.0.0.1:4567' },
      body: { action: 'stop', id: 'a' },
    }),
    /** @type {any} */ (res),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['stop', 'a']);
});

test('action：scan 归一化根目录，add 走 addFromScan', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));

  const scanRes = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'scan', roots: ['/work', '/work'] },
    }),
    /** @type {any} */ (scanRes),
  );
  assert.equal(scanRes.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['scan', ['/work'], undefined]);

  const addRes = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'add', candidateId: 'candidate-1', roots: ['/work'] },
    }),
    /** @type {any} */ (addRes),
  );
  assert.equal(addRes.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['addFromScan', 'candidate-1', ['/work']]);
});

test('action：项目级托管走批量接口，项目移除走 remove-project', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));

  const single = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'add-project', projectId: 'project:/work/a', roots: ['/work'] },
    }),
    /** @type {any} */ (single),
  );
  assert.equal(single.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['addProjectsFromScan', ['project:/work/a'], ['/work']]);

  const batch = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: {
        action: 'add-projects',
        projectIds: ['project:/work/a', 'project:/work/b', 'project:/work/a'],
        roots: ['/work'],
      },
    }),
    /** @type {any} */ (batch),
  );
  assert.equal(batch.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), [
    'addProjectsFromScan',
    ['project:/work/a', 'project:/work/b'],
    ['/work'],
  ]);

  const removed = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'remove-project', projectId: 'project:/work/a' },
    }),
    /** @type {any} */ (removed),
  );
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['removeProject', 'project:/work/a']);

  const invalid = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'add-projects', projectIds: [], roots: ['/work'] },
    }),
    /** @type {any} */ (invalid),
  );
  assert.equal(invalid.statusCode, 400);
});

test('external：按 root 查询外部进程；takeover 走项目接管', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));

  const external = makeRes();
  await handlers.external(
    makeReq({ url: '/plugin/dockyard/external?root=%2Fwork%2Fa' }),
    /** @type {any} */ (external),
  );
  assert.equal(external.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['externalProcesses', ['/work/a']]);
  assert.equal(external.json().processes.length, 1);

  const denied = makeRes();
  await handlers.external(
    makeReq({ url: '/plugin/dockyard/external', remote: '10.0.0.2' }),
    /** @type {any} */ (denied),
  );
  assert.equal(denied.statusCode, 403);

  const takeover = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'takeover-project', projectId: 'project:/work/a', roots: ['/work'] },
    }),
    /** @type {any} */ (takeover),
  );
  assert.equal(takeover.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['takeoverProject', 'project:/work/a']);

  const appTakeover = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'takeover-app', id: 'a' },
    }),
    /** @type {any} */ (appTakeover),
  );
  assert.equal(appTakeover.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['takeoverApp', 'a']);

  const allTakeover = makeRes();
  await handlers.action(
    makeReq({ method: 'POST', headers: ACTION_HEADERS, body: { action: 'takeover-all' } }),
    /** @type {any} */ (allTakeover),
  );
  assert.equal(allTakeover.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['takeoverAll']);
});

test('action：set-guard-policy 校验并保存策略', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));

  const ok = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'set-guard-policy', policy: { enabled: false, maxRetries: 3 } },
    }),
    /** @type {any} */ (ok),
  );
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['setGuardPolicy', { enabled: false, maxRetries: 3 }]);

  const bad = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'set-guard-policy', policy: { maxRetries: 3 } },
    }),
    /** @type {any} */ (bad),
  );
  assert.equal(bad.statusCode, 400);
});

test('action：ping 用于首次安装的路由就绪探测', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));
  const res = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'ping' },
    }),
    /** @type {any} */ (res),
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.result.pong, true);
});

test('action：set-app-port 校验端口并保存', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));

  const ok = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'set-app-port', id: 'a', port: 4000 },
    }),
    /** @type {any} */ (ok),
  );
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['setAppPreferredPort', 'a', 4000]);

  const bad = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'set-app-port', id: 'a', port: 70000 },
    }),
    /** @type {any} */ (bad),
  );
  assert.equal(bad.statusCode, 400);
});

test('action：sync 触发周期同步', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));
  const res = makeRes();
  await handlers.action(
    makeReq({ method: 'POST', headers: ACTION_HEADERS, body: { action: 'sync' } }),
    /** @type {any} */ (res),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['syncProjects']);
});

test('action：set-status-bar 只接受布尔值，并原样交给服务层', async () => {
  const service = makeService();
  const handlers = createDockyardHandlers(/** @type {any} */ (service));

  const off = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'set-status-bar', visible: false },
    }),
    /** @type {any} */ (off),
  );
  assert.equal(off.statusCode, 200);
  assert.deepEqual(service.calls.at(-1), ['setStatusBarVisible', false]);
  assert.deepEqual(off.json().result, { visible: false });

  for (const visible of ['no', 0, null]) {
    const bad = makeRes();
    await handlers.action(
      makeReq({
        method: 'POST',
        headers: ACTION_HEADERS,
        body: { action: 'set-status-bar', visible },
      }),
      /** @type {any} */ (bad),
    );
    assert.equal(bad.statusCode, 400);
  }
});

test('action：相对根目录、未知动作、坏 JSON、超大体与缺字段都给出 4xx', async () => {
  const handlers = createDockyardHandlers(/** @type {any} */ (makeService()));

  const relative = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: { action: 'scan', roots: ['relative'] },
    }),
    /** @type {any} */ (relative),
  );
  assert.equal(relative.statusCode, 400);

  const unknown = makeRes();
  await handlers.action(
    makeReq({ method: 'POST', headers: ACTION_HEADERS, body: { action: 'launch' } }),
    /** @type {any} */ (unknown),
  );
  assert.equal(unknown.statusCode, 400);

  const badJson = makeRes();
  await handlers.action(
    makeReq({ method: 'POST', headers: ACTION_HEADERS, body: '{not json' }),
    /** @type {any} */ (badJson),
  );
  assert.equal(badJson.statusCode, 400);

  const tooLarge = makeRes();
  await handlers.action(
    makeReq({
      method: 'POST',
      headers: ACTION_HEADERS,
      body: 'x'.repeat(70 * 1024),
    }),
    /** @type {any} */ (tooLarge),
  );
  assert.equal(tooLarge.statusCode, 413);

  const missingId = makeRes();
  await handlers.action(
    makeReq({ method: 'POST', headers: ACTION_HEADERS, body: { action: 'start' } }),
    /** @type {any} */ (missingId),
  );
  assert.equal(missingId.statusCode, 400);
});
