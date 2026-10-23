/**
 * dockyard 面板的 HTTP 通道。
 *
 * 为什么要有这一层：面板页需要读状态、读日志、执行启停与扫描。工具调用走的是
 * 会话通道，浏览器页面拿不到；所以 Host 半侧额外提供三条**同源、仅回环**的 JSON 路由。
 *
 * 安全边界（三条一起才成立，不要单独删掉其中一条）：
 *
 * 1. **只接受回环来源。** 路由暴露本机进程列表与启停能力，非 127.0.0.1/::1 一律 403。
 * 2. **不返回任何 CORS 头。** 跨站页面读不到响应。
 * 3. **写操作要求自定义头 `x-dockyard-action: 1` 与 JSON content-type。**
 *    跨站 JS 设置自定义头会触发预检，而本路由不回应预检，浏览器直接拦掉；
 *    HTML 表单又设不了这个头。于是「跨站页面能发一个改变本机进程状态的请求」这条路被堵住。
 *
 * 另外还校验 `Origin`（若浏览器带了）必须与请求的 Host 同源，作为纵深防御。
 * 这里的所有错误都以 JSON 返回，不把异常堆栈泄给页面。
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** 面板状态快照。GET，只读。 */
export const STATUS_ROUTE = '/plugin/dockyard/status';
/** 某个应用的最近日志。GET，只读。 */
export const LOGS_ROUTE = '/plugin/dockyard/logs';
/** 启停、重启、移除、扫描、加入。POST，需要自定义头。 */
export const ACTION_ROUTE = '/plugin/dockyard/action';
/** 外部进程发现。GET，只读。 */
export const EXTERNAL_ROUTE = '/plugin/dockyard/external';

/** 写操作必须携带的头。值没有语义，存在本身就会触发跨站预检。 */
export const ACTION_HEADER = 'x-dockyard-action';

/** 请求体上限。扫描根目录列表也远用不了这么大。 */
const MAX_BODY_BYTES = 64 * 1024;
/** 一次最多接受多少个扫描根目录。 */
const MAX_ROOTS = 32;
/** 日志行数上限，与工具保持一致。 */
const MAX_LOG_LINES = 2000;

/** 带 HTTP 状态码的错误。只把 message 回给页面。 */
export class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   */
  constructor(statusCode, message) {
    super(message);
    /** @type {number} */
    this.statusCode = statusCode;
  }
}

/**
 * 判断来源地址是不是回环。IPv4 映射地址也算。
 * @param {string | undefined} remoteAddress
 * @returns {boolean}
 */
export function isLoopback(remoteAddress) {
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  );
}

/**
 * 把 `~` 展开成家目录。面板里让用户手输绝对路径太苛刻，但只支持这一种简写。
 * @param {string} input
 * @returns {string}
 */
export function expandHome(input) {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

/**
 * 写一个 JSON 响应。刻意不加 CORS 头。
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 */
export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 读取并解析 JSON 请求体。超限、坏 JSON、空体都给出明确的 4xx。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<Record<string, unknown>>}
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;

    /** @param {Error} error */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > limit) {
        fail(new HttpError(413, '请求体过大。'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, '请求体必须是 JSON 对象。'));
          return;
        }
        resolve(/** @type {Record<string, unknown>} */ (parsed));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON。'));
      }
    });
    req.on('error', (error) => fail(new HttpError(400, `读取请求体失败：${error.message}`)));
  });
}

/**
 * 非回环来源统一 403。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} true 表示已经拒绝，调用方应直接返回。
 */
function rejectedByLoopback(req, res) {
  if (isLoopback(req.socket?.remoteAddress)) return false;
  sendJson(res, 403, { ok: false, error: 'dockyard 面板只允许从本机访问。' });
  return true;
}

/**
 * 写操作的额外校验：方法、自定义头、content-type、同源 Origin。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} true 表示已经拒绝。
 */
function rejectedByActionGuard(req, res) {
  if (req.method !== 'POST') {
    res.setHeader?.('allow', 'POST');
    sendJson(res, 405, { ok: false, error: '这个接口只接受 POST。' });
    return true;
  }
  if (req.headers[ACTION_HEADER] !== '1') {
    sendJson(res, 403, {
      ok: false,
      error: `缺少 ${ACTION_HEADER}: 1 请求头；面板操作必须来自 dockyard 页面。`,
    });
    return true;
  }
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    sendJson(res, 415, { ok: false, error: '请求体必须是 application/json。' });
    return true;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (originHost === '' || originHost !== req.headers.host) {
      sendJson(res, 403, { ok: false, error: '拒绝来自其他来源的操作请求。' });
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096) {
    throw new HttpError(400, `${field} 必须是非空字符串。`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {boolean}
 */
function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} 必须是布尔值。`);
  return value;
}

/**
 * 校验字符串数组（去重、非空、上限）。
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @returns {string[]}
 */
function requireStringArray(value, field, max) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, `${field} 必须是非空数组。`);
  }
  if (value.length > max) {
    throw new HttpError(400, `${field} 最多 ${max} 项。`);
  }
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '' || item.length > 4096) {
      throw new HttpError(400, `${field} 里必须都是非空字符串。`);
    }
    const trimmed = item.trim();
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * 规范化扫描根目录：非空、上限、去重、展开 `~`、必须是绝对路径。
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeRoots(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, '至少需要一个扫描根目录。');
  }
  if (value.length > MAX_ROOTS) {
    throw new HttpError(400, `扫描根目录最多 ${MAX_ROOTS} 个。`);
  }
  /** @type {string[]} */
  const roots = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new HttpError(400, '扫描根目录必须是字符串。');
    }
    const trimmed = item.trim();
    if (trimmed === '') continue;
    if (trimmed.length > 4096) {
      throw new HttpError(400, '扫描根目录过长。');
    }
    const expanded = expandHome(trimmed);
    if (!isAbsolute(expanded)) {
      throw new HttpError(400, `扫描根目录必须是绝对路径：${trimmed}`);
    }
    if (!roots.includes(expanded)) roots.push(expanded);
  }
  if (roots.length === 0) {
    throw new HttpError(400, '至少需要一个扫描根目录。');
  }
  return roots;
}

/**
 * 校验日志行数并夹到合法区间。
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeLogLines(value) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(parsed)));
}

/**
 * 按 action 分发到服务层。校验失败抛 HttpError。
 * @param {import('./service.js').DockyardService} service
 * @param {Record<string, unknown>} body
 * @returns {Promise<unknown>}
 */
async function dispatchAction(service, body) {
  const action = typeof body.action === 'string' ? body.action : '';
  switch (action) {
    case 'start':
      return service.start(requireString(body.id, 'id'));
    case 'stop':
      return service.stop(requireString(body.id, 'id'));
    case 'restart':
      return service.restart(requireString(body.id, 'id'));
    case 'remove':
      return service.remove(requireString(body.id, 'id'));
    case 'scan': {
      const roots = normalizeRoots(body.roots);
      return service.scan(roots);
    }
    case 'add': {
      const candidateId = requireString(body.candidateId, 'candidateId');
      const roots = normalizeRoots(body.roots);
      return service.addFromScan(candidateId, roots);
    }
    case 'add-project': {
      const projectId = requireString(body.projectId, 'projectId');
      const roots = normalizeRoots(body.roots);
      return service.addProjectsFromScan([projectId], roots);
    }
    case 'add-projects': {
      const projectIds = requireStringArray(body.projectIds, 'projectIds', 500);
      const roots = normalizeRoots(body.roots);
      return service.addProjectsFromScan(projectIds, roots);
    }
    case 'remove-project': {
      const projectId = requireString(body.projectId, 'projectId');
      return service.removeProject(projectId);
    }
    case 'takeover-project': {
      const projectId = requireString(body.projectId, 'projectId');
      const roots = normalizeRoots(body.roots);
      return service.takeoverProjectFromScan(projectId, roots);
    }
    case 'external': {
      const roots =
        body.roots === undefined || body.roots === null
          ? undefined
          : requireStringArray(body.roots, 'roots', 500).map((root) => expandHome(root));
      return service.externalProcesses(roots);
    }
    case 'sync':
      return service.syncProjects();
    case 'set-status-bar':
      return service.setStatusBarVisible(requireBoolean(body.visible, 'visible'));
    default:
      throw new HttpError(400, `未知操作：${action || '(空)'}。`);
  }
}

/**
 * 创建三条路由的处理函数。与 webServer 解耦，便于直接用假 req/res 测试。
 * @param {import('./service.js').DockyardService} service
 */
export function createDockyardHandlers(service) {
  return {
    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async status(req, res) {
      if (rejectedByLoopback(req, res)) return;
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '这个接口只接受 GET。' });
        return;
      }
      try {
        const applications = await service.list();
        sendJson(res, 200, {
          ok: true,
          generatedAt: Date.now(),
          applications,
          projects: await service.listProjects(),
          system: service.systemSnapshot(),
          // 概览趋势只取最近 120 个聚合点；旧 Host 没有该字段时给空数组。
          resourceHistory: Array.isArray(service.resourceHistory)
            ? service.resourceHistory.slice(-120)
            : [],
          sync: service.lastSync,
          syncIntervalMs: service.syncIntervalMs,
          autoTakeover: service.autoTakeover === true,
          lastAutoTakeover: service.lastAutoTakeover,
          scanRoots: service.store.state.scanRoots,
          preferences: { statusBar: service.statusBarVisible !== false },
          warnings: service.store.problems,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async logs(req, res) {
      if (rejectedByLoopback(req, res)) return;
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '这个接口只接受 GET。' });
        return;
      }
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const id = url.searchParams.get('id');
        if (!id || id.trim() === '') {
          sendJson(res, 400, { ok: false, error: '缺少 id 参数。' });
          return;
        }
        const lines = normalizeLogLines(url.searchParams.get('lines'));
        const result = await service.logs(id, lines);
        sendJson(res, 200, {
          ok: true,
          generatedAt: Date.now(),
          id,
          lines: result.lines,
          source: result.source,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /**
     * 枚举外部进程。GET；roots 通过重复的 ?root= 传入，不传则用已托管项目根目录。
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async external(req, res) {
      if (rejectedByLoopback(req, res)) return;
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '这个接口只接受 GET。' });
        return;
      }
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const roots = url.searchParams
          .getAll('root')
          .map((root) => root.trim())
          .filter((root) => root !== '');
        const result = await service.externalProcesses(roots.length > 0 ? roots : undefined);
        sendJson(res, 200, {
          ok: true,
          processes: result.processes,
          error: result.error,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async action(req, res) {
      if (rejectedByLoopback(req, res)) return;
      if (rejectedByActionGuard(req, res)) return;
      try {
        const body = await readJsonBody(req);
        const action = typeof body.action === 'string' ? body.action : '';
        const result = await dispatchAction(service, body);
        sendJson(res, 200, { ok: true, action, result });
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.statusCode, { ok: false, error: error.message });
          return;
        }
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
