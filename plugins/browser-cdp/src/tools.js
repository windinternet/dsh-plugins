/**
 * 面向智能体的工具集。
 *
 * 这一层的职责只有三件事：**声明参数**、**调用 session**、**把结果渲染成模型能读的文本**。
 * 任何页面语义都不写在这里——那是 src/session.js 的事。保持这个边界，是因为
 * 工具定义会被直接放进每一轮请求的上下文里，改动的代价比内部实现高得多。
 *
 * 渲染原则：
 * - 每个结果都以一行结论开头（做了什么、成没成），让模型一眼能判断。
 * - 动作类工具一律附上页面状态与控制台/网络异常——"成了没有"必须当场可判断，
 *   而不是逼模型再发一次工具调用。
 * - 截图不把 base64 塞进结果：工具结果的展示内容只支持文本块，
 *   所以截图落盘并返回路径（详见 docs/product-specs/browser-cdp.md）。
 */

import { defineTool } from './internal/tool-definition.js';

/** 所有工具共享的超时。导航与等待有自己的内部预算，这里给的是外层兜底。 */
const TOOL_TIMEOUT_MS = 120000;

/** 正文/元素文本在结果里的展示上限。 */
const RENDER_LIMIT = 4000;

/**
 * 构造全部浏览器工具。
 *
 * @param {object} deps
 * @param {import('./session.js').ManagedBrowser} deps.browser
 * @param {() => boolean} [deps.isAvailable] 返回 false 时工具仍注册但会明确报不可用
 * @returns {any[]} defineTool 定义数组
 */
export function createBrowserTools(deps) {
  const browser = deps.browser;
  const isAvailable = deps.isAvailable ?? (() => true);

  /**
   * 统一包一层：把内部异常翻译成"带下一步建议"的错误。
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const guarded = async (task) => {
    if (!isAvailable()) {
      throw new Error('浏览器工具当前不可用：插件被配置为禁用，或宿主环境不允许启动子进程。');
    }
    try {
      return await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    }
  };

  return [
    defineTool({
      name: 'browser_open',
      description:
        '启动（或复用）受管浏览器并打开页面。返回真实 CDP 端口、浏览器版本与页面状态。第一次使用其它 browser_* 工具时也会自动启动。',
      parameters: {
        url: {
          type: 'string',
          description: '要打开的地址。省略时保持当前页面（首次启动则停在 about:blank）。',
        },
        headless: { type: 'boolean', description: '是否无头运行。省略时用插件配置（默认无头）。' },
        timeoutMs: { type: 'number', description: '导航等待上限（毫秒），默认 30000。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            browser: { type: 'string', required: true },
            port: { type: 'integer', required: true },
            reused: { type: 'boolean', required: true },
            sandboxDisabled: { type: 'boolean', required: true },
            profileDir: { type: 'string', required: true },
            cdpEndpoint: { type: 'string', required: true },
            pageUrl: { type: 'string', required: true },
            pageTitle: { type: 'string', required: true },
            text: { type: 'string' },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderOpen(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      async execute(args, _exec) {
        return guarded(async () => {
          const report = await browser.ensure({
            url: args.url === undefined ? undefined : String(args.url),
            headless: args.headless === undefined ? undefined : args.headless === true,
            timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
          });
          /** @type {string[]} */
          const notes = [];
          if (report.reused) notes.push('浏览器已在运行，复用了现有实例与页面。');
          if (report.sandboxDisabled) {
            notes.push(
              '该实例以 --no-sandbox 启动（关闭浏览器自身沙箱）。原因是配置指定，或正常启动时渲染进程未能存活。',
            );
          }
          return {
            browser: report.browser,
            port: Number(report.port ?? 0),
            reused: report.reused,
            sandboxDisabled: report.sandboxDisabled,
            profileDir: report.profileDir,
            cdpEndpoint: report.cdpEndpoint,
            pageUrl: report.page.url,
            pageTitle: report.page.title,
            text: report.page.text,
            notes,
          };
        });
      },
    }),

    defineTool({
      name: 'browser_navigate',
      description:
        '在当前页面导航到指定地址，并等到 DOM 可交互（或 load）。返回最终 URL、标题与正文摘要。',
      parameters: {
        url: { type: 'string', required: true, description: '目标地址。不带协议时按 https 补全。' },
        waitUntil: {
          type: 'string',
          enum: ['domcontentloaded', 'load', 'none'],
          description: '等到哪个阶段。默认 domcontentloaded；none 表示发出导航就返回。',
        },
        timeoutMs: { type: 'number', description: '等待上限（毫秒），默认 30000。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            readyState: { type: 'string', required: true },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderPage('已导航', value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      async execute(args, _exec) {
        return guarded(async () => {
          const page = await browser.navigate(String(args.url), {
            waitUntil: /** @type {any} */ (args.waitUntil ?? 'domcontentloaded'),
            timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
          });
          return { url: page.url, title: page.title, readyState: page.readyState, text: page.text };
        });
      },
    }),

    defineTool({
      name: 'browser_snapshot',
      description:
        '列出页面上可交互的元素（按钮/链接/输入框等），每个带一个引用号、文本、标签与是否在视口内。用引用号做点击/输入定位，比写 CSS 选择器稳。页面变化后引用号会失效，需要重新快照。',
      parameters: {
        limit: { type: 'number', description: '最多返回多少个元素（默认 150，上限 150）。' },
        selector: {
          type: 'string',
          description: '只关心某个容器内部时给出 CSS 选择器（仅用于报告该容器内的元素总数）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
            scrollY: { type: 'integer', required: true },
            scrollHeight: { type: 'integer', required: true },
            viewport: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
              },
            },
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  ref: { type: 'string', required: true },
                  tag: { type: 'string', required: true },
                  text: { type: 'string', required: true },
                  x: { type: 'integer', required: true },
                  y: { type: 'integer', required: true },
                  inViewport: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderSnapshot(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        return guarded(async () => {
          const snapshot = await browser.snapshot({
            limit: args.limit === undefined ? undefined : Number(args.limit),
            selector: args.selector === undefined ? undefined : String(args.selector),
          });
          return {
            url: snapshot.url,
            title: snapshot.title,
            total: snapshot.total,
            truncated: snapshot.truncated,
            scrollY: snapshot.scrollY,
            scrollHeight: snapshot.scrollHeight,
            viewport: snapshot.viewport,
            items: snapshot.items.map((item) => ({
              ref: item.ref,
              tag: item.tag,
              text: item.text,
              x: item.x,
              y: item.y,
              inViewport: item.inViewport,
              ...(item.role === undefined ? {} : { role: item.role }),
              ...(item.id === undefined ? {} : { id: item.id }),
              ...(item.name === undefined ? {} : { name: item.name }),
              ...(item.href === undefined ? {} : { href: item.href }),
              ...(Object.keys(item.state).length === 0 ? {} : { state: item.state }),
            })),
          };
        });
      },
    }),

    defineTool({
      name: 'browser_content',
      description:
        '读取页面（或指定元素）的内容：默认是可见文本，format: html 时是 HTML 源码。适合读正文、核对文案、抓列表。',
      parameters: {
        format: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'text（默认）读可见文本；html 读 outerHTML。',
        },
        ref: { type: 'string', description: '限定到某个快照引用号对应的元素。' },
        selector: { type: 'string', description: '限定到某个 CSS 选择器对应的元素。' },
        limit: { type: 'number', description: '最多返回多少字符（默认 20000）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            scope: { type: 'string', required: true },
            format: { type: 'string', required: true },
            length: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
            content: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderContent(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        return guarded(async () => {
          const result = await browser.content({
            format: /** @type {any} */ (args.format ?? 'text'),
            ref: args.ref === undefined ? undefined : String(args.ref),
            selector: args.selector === undefined ? undefined : String(args.selector),
            limit: args.limit === undefined ? undefined : Number(args.limit),
          });
          return {
            url: result.url,
            title: result.title,
            scope: result.scope,
            format: result.format,
            length: result.length,
            truncated: result.truncated,
            content: result.content,
          };
        });
      },
    }),

    defineTool({
      name: 'browser_get',
      description:
        '读一个元素的细节：文本、value、可见性、是否禁用、是否选中、几何位置与全部属性。用来在动作前后核对状态。',
      parameters: {
        ref: { type: 'string', description: '快照引用号。' },
        selector: { type: 'string', description: 'CSS 选择器（与 ref 二选一）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            reason: { type: 'string' },
            element: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderElement(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        return guarded(async () => {
          const result = await browser.inspect({
            ref: args.ref === undefined ? undefined : String(args.ref),
            selector: args.selector === undefined ? undefined : String(args.selector),
          });
          return result.found
            ? { found: true, element: result.element }
            : { found: false, reason: result.reason ?? '未找到元素。' };
        });
      },
    }),

    defineTool({
      name: 'browser_click',
      description:
        '在元素中心发送真实鼠标事件（不是 JS click）。定位可用快照引用号、CSS 选择器或坐标。返回动作后的页面状态与页面报错。',
      parameters: {
        ref: { type: 'string', description: '快照引用号（推荐）。' },
        selector: { type: 'string', description: 'CSS 选择器。' },
        x: { type: 'number', description: '视口坐标 x（与 y 一起用）。' },
        y: { type: 'number', description: '视口坐标 y。' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: '鼠标键，默认 left。',
        },
        clickCount: { type: 'number', description: '点击次数，2 表示双击。默认 1。' },
      },
      output: {
        schema: actionSchema(),
        render: (_args, value) => [{ type: 'text', text: renderAction(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      async execute(args, _exec) {
        return guarded(async () =>
          projectAction(
            await browser.click({
              ref: args.ref === undefined ? undefined : String(args.ref),
              selector: args.selector === undefined ? undefined : String(args.selector),
              x: args.x === undefined ? undefined : Number(args.x),
              y: args.y === undefined ? undefined : Number(args.y),
              button: /** @type {any} */ (args.button ?? 'left'),
              clickCount: args.clickCount === undefined ? undefined : Number(args.clickCount),
            }),
          ),
        );
      },
    }),

    defineTool({
      name: 'browser_type',
      description:
        '往输入框/文本域/contenteditable 里输入文本（真实输入路径，支持中文）。默认先清空；submit: true 表示输入后按回车。',
      parameters: {
        ref: { type: 'string', description: '快照引用号（推荐）。' },
        selector: { type: 'string', description: 'CSS 选择器。' },
        text: { type: 'string', required: true, description: '要输入的文本。' },
        submit: { type: 'boolean', description: '输入后按 Enter。默认 false。' },
        append: {
          type: 'boolean',
          description: '为 true 时保留原有内容，追加输入。默认 false（先清空）。',
        },
      },
      output: {
        schema: actionSchema(),
        render: (_args, value) => [{ type: 'text', text: renderAction(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      async execute(args, _exec) {
        return guarded(async () =>
          projectAction(
            await browser.type({
              ref: args.ref === undefined ? undefined : String(args.ref),
              selector: args.selector === undefined ? undefined : String(args.selector),
              text: String(args.text),
              submit: args.submit === true,
              append: args.append === true,
            }),
          ),
        );
      },
    }),

    defineTool({
      name: 'browser_key',
      description:
        '发送按键或组合键，例如 Enter、Escape、Tab、ArrowDown，或带修饰键的组合（modifiers: ["Meta"] + key "a" 表示全选）。',
      parameters: {
        key: { type: 'string', required: true, description: '键名，或单个字符。' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: '修饰键数组，可选 Alt / Ctrl / Meta / Shift。',
        },
        ref: { type: 'string', description: '先聚焦到这个元素再按键（可选）。' },
      },
      output: {
        schema: actionSchema(),
        render: (_args, value) => [{ type: 'text', text: renderAction(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      async execute(args, _exec) {
        return guarded(async () => {
          if (args.ref !== undefined && String(args.ref) !== '') {
            await browser.inspect({ ref: String(args.ref) });
          }
          return projectAction(
            await browser.press({
              key: String(args.key),
              modifiers: Array.isArray(args.modifiers)
                ? args.modifiers.map((/** @type {any} */ item) => String(item))
                : [],
            }),
          );
        });
      },
    }),

    defineTool({
      name: 'browser_wait',
      description:
        '等待条件成立：某个选择器出现（selector）、页面文本出现（text），或网络静默（都不给时按网络静默判断）。超时会明确返回 timedOut。',
      parameters: {
        selector: { type: 'string', description: '等这个选择器出现且可见。' },
        text: { type: 'string', description: '等页面可见文本里出现这段文字。' },
        timeoutMs: { type: 'number', description: '等待上限（毫秒），默认 10000。' },
        networkIdleMs: { type: 'number', description: '网络静默判定窗口（毫秒），默认 500。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            timedOut: { type: 'boolean', required: true },
            condition: { type: 'string', required: true },
            waitedMs: { type: 'integer', required: true },
            pageUrl: { type: 'string', required: true },
            pageTitle: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.ok
              ? `等待成功：${value.condition}（${value.waitedMs}ms）\n页面：${value.pageTitle} <${value.pageUrl}>`
              : `等待超时：${value.condition} 在 ${value.waitedMs}ms 内没有成立。页面：${value.pageTitle} <${value.pageUrl}>\n可以再试一次、放宽 timeoutMs，或先 browser_snapshot 看看页面现在是什么状态。`,
          },
        ],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        return guarded(async () => {
          const result = await browser.wait({
            selector: args.selector === undefined ? undefined : String(args.selector),
            text: args.text === undefined ? undefined : String(args.text),
            timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
            networkIdleMs:
              args.networkIdleMs === undefined ? undefined : Number(args.networkIdleMs),
          });
          const page = await browser.currentPageReport();
          return {
            ok: result.ok,
            timedOut: result.timedOut,
            condition: result.condition,
            waitedMs: result.waitedMs,
            pageUrl: page.url,
            pageTitle: page.title,
          };
        });
      },
    }),

    defineTool({
      name: 'browser_screenshot',
      description:
        '截图并保存为 PNG/JPEG 文件，返回文件绝对路径与像素尺寸（用 read_image 查看，或用 present 给用户）。可选整页截图或只截某个元素。',
      parameters: {
        fullPage: { type: 'boolean', description: '是否截取整页（默认只截当前视口）。' },
        ref: { type: 'string', description: '只截这个快照元素。' },
        selector: { type: 'string', description: '只截这个 CSS 选择器对应的元素。' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png。' },
        quality: { type: 'number', description: 'JPEG 质量 1-100，默认 80。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            width: { type: 'integer', required: true },
            height: { type: 'integer', required: true },
            fullPage: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `截图已保存：${value.path}\n尺寸 ${value.width}×${value.height}，${value.bytes} 字节${value.fullPage ? '（整页）' : ''}`,
          },
        ],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        return guarded(async () =>
          browser.screenshot({
            fullPage: args.fullPage === true,
            ref: args.ref === undefined ? undefined : String(args.ref),
            selector: args.selector === undefined ? undefined : String(args.selector),
            format: /** @type {any} */ (args.format ?? 'png'),
            quality: args.quality === undefined ? undefined : Number(args.quality),
          }),
        );
      },
    }),

    defineTool({
      name: 'browser_eval',
      description:
        '在当前页面里执行一段 JavaScript 表达式并返回按值序列化的结果（支持 await Promise）。用于 HTTP 拿不到的状态、复杂查询或页面内 API 调用。',
      parameters: {
        expression: {
          type: 'string',
          required: true,
          description: '要执行的 JS 表达式，例如 document.title 或 (async () => 1)()。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true },
            unserializable: { type: 'boolean', required: true },
            value: { type: 'json' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.unserializable
              ? `表达式执行完成，但返回值无法按值序列化（类型 ${value.type}）。需要可读结果时请在表达式末尾显式 JSON.stringify(...)。`
              : `表达式结果（${value.type}）：\n${truncate(safeStringify(value.value), RENDER_LIMIT)}`,
          },
        ],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        return guarded(async () => {
          const result = await browser.evaluate(String(args.expression));
          return {
            type: result.type,
            unserializable: result.unserializable,
            value: toJsonValue(result.value),
          };
        });
      },
    }),

    defineTool({
      name: 'browser_network',
      description:
        '读取本次会话记录到的网络请求（方法、URL、状态码、失败原因）。调试"页面为什么没出来"时先看这里。',
      parameters: {
        limit: { type: 'number', description: '最多返回多少条，默认 50。' },
        onlyFailures: { type: 'boolean', description: '只看失败与 4xx/5xx。' },
        urlContains: { type: 'string', description: '只保留 URL 含该子串的请求。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dropped: { type: 'integer', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  method: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                  status: { type: 'integer' },
                  failed: { type: 'boolean' },
                  errorText: { type: 'string' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderNetwork(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        return guarded(async () => {
          const result = browser.readNetwork({
            limit: args.limit === undefined ? undefined : Number(args.limit),
            onlyFailures: args.onlyFailures === true,
            urlContains: args.urlContains === undefined ? undefined : String(args.urlContains),
          });
          return {
            dropped: result.dropped,
            entries: result.entries.map((entry) => ({
              method: entry.method,
              url: entry.url,
              ...(entry.status === undefined ? {} : { status: entry.status }),
              ...(entry.failed === true ? { failed: true } : {}),
              ...(entry.errorText === undefined ? {} : { errorText: entry.errorText }),
              ...(entry.finishedAt === undefined
                ? {}
                : { durationMs: Math.round((entry.finishedAt - entry.startedAt) * 1000) }),
            })),
          };
        });
      },
    }),

    defineTool({
      name: 'browser_console',
      description:
        '读取页面控制台输出、未捕获异常与浏览器日志（含 404 之类的资源错误）。用来发现被 UI 掩盖的报错。',
      parameters: {
        limit: { type: 'number', description: '最多返回多少条，默认 50。' },
        onlyErrors: { type: 'boolean', description: '只看 error 与 warning。' },
        clear: { type: 'boolean', description: '读取后清空缓冲区。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dropped: { type: 'integer', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  level: { type: 'string', required: true },
                  source: { type: 'string', required: true },
                  text: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderConsole(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        return guarded(async () => {
          const result = browser.readConsole({
            limit: args.limit === undefined ? undefined : Number(args.limit),
            onlyErrors: args.onlyErrors === true,
            clear: args.clear === true,
          });
          return {
            dropped: result.dropped,
            entries: result.entries.map((entry) => ({
              level: entry.level,
              source: entry.source,
              text: entry.text,
            })),
          };
        });
      },
    }),

    defineTool({
      name: 'browser_tabs',
      description: '管理页面标签：列出（默认）、新建、切换、关闭。新开的标签会自动成为当前页面。',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'new', 'select', 'close'],
          description: '默认 list。',
        },
        url: { type: 'string', description: 'action: new 时要打开的地址。' },
        targetId: {
          type: 'string',
          description: 'action: select / close 时的目标 id（来自 list）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            current: { type: 'string' },
            tabs: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  targetId: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  current: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderTabs(value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      async execute(args, _exec) {
        return guarded(async () => {
          const result = await browser.tabs({
            action: /** @type {any} */ (args.action ?? 'list'),
            url: args.url === undefined ? undefined : String(args.url),
            targetId: args.targetId === undefined ? undefined : String(args.targetId),
          });
          return {
            action: result.action,
            ...(result.current === undefined ? {} : { current: result.current }),
            tabs: result.tabs,
          };
        });
      },
    }),

    defineTool({
      name: 'browser_close',
      description:
        '关闭受管浏览器进程并确认它真的退出了（温和终止 → 超时强杀）。profile 会保留，登录态不丢。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            closed: { type: 'boolean', required: true },
            method: { type: 'string', required: true },
            waitedMs: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.closed
              ? `浏览器已关闭（${value.method}，${value.waitedMs}ms）。profile 保留在插件数据目录，登录态会在下次启动时恢复。`
              : `浏览器进程在 ${value.waitedMs}ms 内没有退出，状态不可信。可以用系统工具确认是否还有残留进程。`,
          },
        ],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      async execute(_args, _exec) {
        return guarded(async () => browser.close());
      },
    }),
  ];
}

/**
 * 动作类工具共用的输出 schema。
 *
 * @returns {any}
 */
function actionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', required: true },
      target: { type: 'string', required: true },
      ok: { type: 'boolean', required: true },
      scrolled: { type: 'boolean' },
      pageUrl: { type: 'string', required: true },
      pageTitle: { type: 'string', required: true },
      pageText: { type: 'string' },
      pageError: { type: 'string' },
      console: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            level: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
      },
      failedRequests: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            method: { type: 'string', required: true },
            url: { type: 'string', required: true },
            errorText: { type: 'string' },
          },
        },
      },
    },
  };
}

/**
 * 把 session 的动作报告投影成工具声明的输出形状。
 *
 * 必须在这里投影而不是在 render 里：工具返回值本身要过 output.schema 校验，
 * 把内部的 report 结构直接丢出去会以"输出校验失败"炸掉——那种错误对使用者毫无信息量。
 *
 * @param {any} report
 * @returns {any}
 */
function projectAction(report) {
  return {
    action: report.action,
    target: report.target,
    ok: report.ok,
    ...(report.scrolled === undefined ? {} : { scrolled: report.scrolled === true }),
    pageUrl: report.page?.url ?? '',
    pageTitle: report.page?.title ?? '',
    pageText: report.page?.text ?? '',
    ...(report.pageError === undefined ? {} : { pageError: report.pageError }),
    console: (report.console ?? []).map((/** @type {any} */ entry) => ({
      level: String(entry.level),
      text: String(entry.text).slice(0, 500),
    })),
    failedRequests: (report.failedRequests ?? []).map((/** @type {any} */ entry) => ({
      method: String(entry.method),
      url: String(entry.url),
      ...(entry.errorText === undefined ? {} : { errorText: String(entry.errorText) }),
    })),
  };
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderOpen(value) {
  const lines = [
    `${value.reused ? '已复用' : '已启动'}浏览器：${value.browser}`,
    `CDP 端口：${value.port}（${value.cdpEndpoint}）`,
    `profile：${value.profileDir}`,
  ];
  if (value.pageUrl !== '')
    lines.push(`当前页面：${value.pageTitle || '(无标题)'} <${value.pageUrl}>`);
  if (Array.isArray(value.notes) && value.notes.length > 0)
    lines.push(...value.notes.map((/** @type {any} */ note) => `注意：${note}`));
  if (typeof value.text === 'string' && value.text !== '')
    lines.push(`正文摘要：${truncate(value.text, 400)}`);
  return lines.join('\n');
}

/**
 * @param {string} prefix
 * @param {any} value
 * @returns {string}
 */
function renderPage(prefix, value) {
  return `${prefix}：${value.title || '(无标题)'} <${value.url}>（readyState=${value.readyState}）${
    typeof value.text === 'string' && value.text !== ''
      ? `\n正文摘要：${truncate(value.text, 400)}`
      : ''
  }`;
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderSnapshot(value) {
  const head = `${value.title || '(无标题)'} <${value.url}>\n视口 ${value.viewport.width}×${value.viewport.height}，页面高 ${value.scrollHeight}，滚动位置 ${value.scrollY}`;
  if (value.items.length === 0) {
    return `${head}\n没有找到可交互元素。页面可能还没渲染完（试试 browser_wait），或者内容不在这个标签里。`;
  }
  const lines = value.items.map((/** @type {any} */ item) => {
    const flags = [];
    if (item.inViewport === false) flags.push('视口外');
    if (item.state?.disabled === true) flags.push('禁用');
    if (item.state?.checked === true) flags.push('已选中');
    if (typeof item.state?.selected === 'string' && item.state.selected !== '')
      flags.push(`选中=${item.state.selected}`);
    const suffix = flags.length === 0 ? '' : ` [${flags.join(',')}]`;
    const text = item.text === '' ? '(无文本)' : truncate(item.text, 80);
    return `${item.ref}\t${item.tag}${item.role === undefined ? '' : `[${item.role}]`}\t${text}${suffix}`;
  });
  const tail = value.truncated
    ? `\n（只列出前 ${value.items.length} 个，共 ${value.total}+ 个元素；需要更多请用 selector 缩小范围）`
    : '';
  return `${head}\n引用号\t标签\t文本\n${lines.join('\n')}${tail}`;
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderContent(value) {
  const head = `${value.title || '(无标题)'} <${value.url}>（范围：${value.scope}，${value.format}，${value.length} 字符${value.truncated ? '，已截断' : ''}）`;
  return `${head}\n${truncate(value.content, RENDER_LIMIT)}`;
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderElement(value) {
  if (value.found !== true) return `未找到元素：${value.reason ?? '原因未知'}`;
  const element = value.element ?? {};
  const lines = [
    `<${element.tag}> 可见=${String(element.visible)} 禁用=${String(element.disabled)}`,
    `文本：${truncate(String(element.text ?? ''), 300)}`,
  ];
  if (typeof element.value === 'string') lines.push(`value：${truncate(element.value, 200)}`);
  if (typeof element.checked === 'boolean') lines.push(`checked：${element.checked}`);
  if (element.rect !== undefined)
    lines.push(
      `位置：(${element.rect.x}, ${element.rect.y}) ${element.rect.width}×${element.rect.height}`,
    );
  const attributes = element.attributes ?? {};
  const keys = Object.keys(attributes);
  if (keys.length > 0)
    lines.push(
      `属性：${keys
        .slice(0, 12)
        .map((key) => `${key}=${truncate(String(attributes[key]), 60)}`)
        .join(' ')}`,
    );
  return lines.join('\n');
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderAction(value) {
  const lines = [
    `${value.action}：${value.ok ? '已执行' : '执行了但页面有异常'} — ${value.target}`,
  ];
  if (value.scrolled === true) lines.push('（元素原本不在视口内，已滚动到视口中心后再操作）');
  lines.push(`页面：${value.pageTitle || '(无标题)'} <${value.pageUrl}>`);
  if (typeof value.pageText === 'string' && value.pageText !== '')
    lines.push(`正文摘要：${truncate(value.pageText, 300)}`);
  if (typeof value.pageError === 'string') lines.push(`回读页面状态失败：${value.pageError}`);
  if (Array.isArray(value.console) && value.console.length > 0) {
    lines.push('最近控制台：');
    lines.push(
      ...value.console.map(
        (/** @type {any} */ entry) => `  [${entry.level}] ${truncate(entry.text, 200)}`,
      ),
    );
  }
  if (Array.isArray(value.failedRequests) && value.failedRequests.length > 0) {
    lines.push('失败请求：');
    lines.push(
      ...value.failedRequests.map(
        (/** @type {any} */ entry) =>
          `  ${entry.method} ${truncate(entry.url, 160)}${entry.errorText === undefined ? '' : ` — ${entry.errorText}`}`,
      ),
    );
  }
  return lines.join('\n');
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderNetwork(value) {
  if (value.entries.length === 0) return '没有符合条件的网络请求记录。';
  const lines = value.entries.map((/** @type {any} */ entry) => {
    const status =
      entry.failed === true ? `失败(${entry.errorText ?? '未知'})` : (entry.status ?? 'pending');
    const duration = entry.durationMs === undefined ? '' : ` ${entry.durationMs}ms`;
    return `${status}\t${entry.method}\t${truncate(entry.url, 200)}${duration}`;
  });
  const head = `最近 ${value.entries.length} 条请求${value.dropped > 0 ? `（更早的 ${value.dropped} 条已省略）` : ''}`;
  return `${head}\n${lines.join('\n')}`;
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderConsole(value) {
  if (value.entries.length === 0) return '控制台没有符合条件的记录。';
  const lines = value.entries.map(
    (/** @type {any} */ entry) => `[${entry.level}] (${entry.source}) ${truncate(entry.text, 400)}`,
  );
  const head = `最近 ${value.entries.length} 条${value.dropped > 0 ? `（更早的 ${value.dropped} 条已省略）` : ''}`;
  return `${head}\n${lines.join('\n')}`;
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderTabs(value) {
  const lines = value.tabs.map(
    (/** @type {any} */ tab) =>
      `${tab.current ? '*' : ' '} ${tab.targetId}\t${truncate(tab.title || '(无标题)', 60)}\t${truncate(tab.url, 120)}`,
  );
  return `标签（${value.tabs.length} 个，* 为当前）：\n${lines.join('\n') || '  （没有标签）'}`;
}

/**
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function truncate(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 把任意 JS 值收敛成可安全放进工具结果的 JSON 值。
 *
 * 工具输出 schema 会做严格校验，而页面里返回的东西可能是函数、循环引用或 undefined，
 * 一旦直接透传就会以"output 校验失败"的形式炸掉——那对使用者毫无信息量。
 *
 * @param {unknown} value
 * @returns {any}
 */
function toJsonValue(value) {
  if (value === undefined || value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (type === 'function') return '[function]';
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return '[无法序列化的值]';
  }
}

export { projectAction };
