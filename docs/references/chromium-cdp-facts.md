# Chromium / CDP 事实卡

本文件记录**实测与官方材料核对过**的事实，供 browser-cdp 插件与后续维护者使用。
写在这里的理由：这些结论有的是踩过坑才得到的，有的是从官方仓库/决策记录里查出来的，
不写下来就会被下一次"我觉得应该可以"覆盖掉。

| 项         | 值                                                                   |
| ---------- | -------------------------------------------------------------------- |
| 核对时间   | 2026-10-16                                                           |
| 宿主       | `@deepseek-ai/dsh@0.2.0-rc.2`（DeepSeek Harness Desktop 0.2.0-rc.2） |
| 本机浏览器 | Google Chrome 155.0.8059.40（`/Applications/Google Chrome.app`）     |
| 实测协议   | CDP 1.3，浏览器级端点 `/devtools/browser/<id>`，扁平会话可用         |

## 一、DSH 内置 Sidebar 浏览器为什么不能被插件自动化

这一条是本插件存在的前提，必须写清楚，否则后来者会反复尝试。

**结论：** DSH Desktop 的"浏览器"是右侧 Sidebar 的一个 tab，Desktop 载体是 Electron
`<webview>` guest。官方**没有**提供任何自动化接缝，插件也无法间接拿到它。

证据（逐条可复核）：

1. 实现的包是 `@deepseek-ai/dsh-client-ui-sidebar-browser`（随 App 分发，
   路径 `app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-browser/`）。
   它的 README 明确写着该包**不注册任何工具、不注册 prompt section**，
   "浏览内容不进入模型请求"。
2. Desktop 主进程用 `DesktopBrowserGuests`（`app.asar/lib/main.js` 内
   `lib/types/browser-guests.js` 区域）管理 guest 租约：分区名是
   `dsh-sidebar-browser-${randomUUID()}`（**非持久**，Cookie 与 Web storage 不跨重启保留），
   并在 `will-attach-webview` 上强制 `sandbox: true`、`nodeIntegration: false`。
3. 官方决策记录
   [2026-09-20-desktop-browser-webview](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.md)
   原文：该实现"不增加 remote-debugging 端点，也不提供 browser-use 集成"，
   未来的自动化提供方需要"一个已认证、按 target 授权的 broker，而不是访问全部应用 target"。
   `apps/desktop/README.md` 另有一句：打包后内嵌浏览器 guest 会**禁用 DevTools**。
4. 整个 `app.asar`（121 MB，12973 个条目）全字节扫描：
   `remote-debugging`、`appendSwitch`、`webContents.debugger`、`debugger.attach` **全部 0 命中**。
   唯一的 inspector 开关是给宿主子进程的 Node `--inspect`（`DSH_DESKTOP_HOST_INSPECT_PORT`，
   仅开发用）。
5. **插件跑在哪里**决定了它拿不到 webContents：桌面主进程
   （`app.asar/lib/main.js`）把 DSH 宿主作为**独立子进程**启动，环境变量是
   `ELECTRON_RUN_AS_NODE=1`，入口是 `dsh-desktop-host/lib/index.js`。
   插件代码全部运行在这个子进程里，没有 `require('electron')` 可用。
   `webContents.debugger.attach()` 只存在于 Electron 主进程。

**因此：** 插件若要自动化浏览器，正确形态是**自己启动并持有一个 Chromium**
（这也是官方 `ctx.browserUse` 体系下三个官方提供方的一致形态）。
`--remote-debugging-port` 是启动期开关，运行中的 Electron 应用无法追加，所以"接管 App 自己的浏览器"
在插件层面不可达。

### 决定记录（2026-10-16）：不接管内置浏览器

在确认上面这些证据之后，本项目**决定不做**"接管内置 Sidebar 浏览器"：
受管实例（插件自己启动 Chromium）是唯一在插件层可达且能拿到完整 CDP 的形态。
把结论固化的三条拦阻，每条都实测过：

| 拦阻             | 实测证据                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| 插件拿不到 `app` | 插件跑在 `ELECTRON_RUN_AS_NODE=1` 的宿主子进程里，`require('electron')` 只得到路径字符串  |
| 时机上永远太晚   | `--remote-debugging-port` 是**启动期**开关；插件被加载时 Chromium 已经在跑                |
| 改文件会被挡     | `Info.plist` 带 `ElectronAsarIntegrity`（`app.asar` + `default_app.asar` 的 SHA256）；    |
|                  | 且 App 有 Developer ID 代码签名（`codesign --verify --deep --strict` 当前通过），改即失效 |

另外实测：直接把 switch 递给 App 二进制会被**参数白名单**拒绝
（`DeepSeek Harness: bad option: --remote-debugging-port`，`--enable-logging`、
`--headless=new`、`--user-data-dir` 同样被拒）；`ELECTRON_EXTRA_LAUNCH_ARGS`、
`ELECTRON_ARGS`、`CHROMIUM_FLAGS` 三种注入全部无效；把 App 的 Electron 二进制当普通
Chromium 用也同样 `bad option`（它带自己的参数解析）。

要绕过这三条，唯一位置是在 `lib/main.js` 的入口调用之前插一行
`app.commandLine.appendSwitch('remote-debugging-port', '<port>')`——
那是**改 App 本体**（需重打包、重签名，且升级即被覆盖），不属于插件职责。
如果 DeepSeek 官方未来提供该开关（推荐形态是按 target 授权的 broker，而不是把整个应用的
CDP 暴露在回环端口上），本插件的会话层已经能枚举并 attach `webview` 类型的 target，
加一个 attach 模式即可接入。

## 二、CDP 的接口事实

- **HTTP 端点**（`--remote-debugging-port=<p>` 之后）：`/json/version`（返回
  `Browser`、`Protocol-Version`、`webSocketDebuggerUrl`）、`/json/list`（各 target 的
  `webSocketDebuggerUrl`）、`/json/protocol`、`/json/new`（**只接受 PUT**）、
  `/json/activate`、`/json/close`。
- **两条 WebSocket 路径**：`/devtools/browser/<id>`（浏览器级）与 `/devtools/page/<id>`（页面级）。
  浏览器级 + `Target.attachToTarget({ flatten: true })` 会返回 `sessionId`，
  后续命令带 `sessionId` 字段即可路由到具体页面——一条连接管多个标签，这是本插件的做法。
- **Origin 检查**：Chromium 会校验 WebSocket 的 Origin，除非启动时给了
  `--remote-allow-origins`。Node 的全局 `WebSocket` 不发送 Origin 头，因此不受影响
  （本机 Node 24 实测通过）。
- **常用域**：`Page`（导航、截图、生命周期）、`Runtime`（求值、console、异常）、
  `Input`（真实鼠标/键盘事件）、`Network`（请求与失败原因）、`Log`（浏览器侧日志，含 404）、
  `Target`（标签管理）、`DOM`/`Accessibility`（结构快照的备选来源）。
- **文本输入**：`Input.insertText` 是唯一能正确处理中文等无法用单键事件表达的输入路径；
  `Input.dispatchKeyEvent` 处理具名键与组合键（修饰位：Alt=1、Ctrl=2、Meta=4、Shift=8）。
- **`/json/list` 里的 target 类型**：普通页面是 `page`；Electron 的 `<webview>` guest 会以
  `webview` 出现（这也是"第三方 Playwright 看不到 Sidebar 浏览器"的原因——
  它只枚举 `page`）。

## 三、本机实测结论（决定实现取舍）

这些是跑出来的，不是推断：

1. **只给 `--remote-debugging-port` 不够，必须同时给 `--user-data-dir`。**
   不给独立 profile 时，新进程会与用户正在运行的 Chrome 合并（或直接退出），
   调试端口不会出现在我们期望的进程上。给了独立 profile 才是真正独立、可控的实例。
2. **在受限执行环境（本机 DSH 的沙箱）里，Chromium 渲染进程会立刻 `SIGTRAP`。**
   三种模式（GUI / `--headless=new` / `--headless=old`）表现一致：DevTools HTTP 端点起得来，
   但 attach 后所有页面级命令超时。加 `--no-sandbox` 后全部正常。
   因此实现策略是**先按正常方式启动，检测到渲染进程没活下来再关闭浏览器沙箱重试一次，
   并把这次回退如实报告**——而不是默认就关沙箱。
3. **`--headless=new` 下 `Page.captureScreenshot` 正常**，返回 base64 PNG；
   真实导航（https://example.com）与 `Runtime.evaluate` 读回标题都正常。
4. **`--remote-debugging-port` 的端口不能靠"我猜它空着"**：必须两级确认——
   先在回环地址上真正 listen 一次（唯一可靠的"空闲"证据），启动后还要能问到
   `/json/version`（否则可能连上了一个身份不明的端点）。
   本插件默认在 `24000-24060` 里探测，刻意避开 9222（他人常用）与开发服务常用段。

## 四、插件 API 侧的事实（写插件时直接相关）

- `defineTool` 必填 `name`、`description`、`parameters`、`output.schema`、**`output.render`**、
  `execute`；缺 `render` 在注册时就是硬 `TypeError`。
- `execute(args, exec)` 的返回值**只**是声明的 JSON 值，要过 `output.schema` 校验；
  展示用的内容块（`[{ type: 'text', text }]`）由 `output.render(args, value)` 产出。
  工具结果的展示内容**只支持文本块**，没有图片块——这也是截图必须落盘返回路径的原因。
- `exec` 提供 `{ signal, agent?, callId, ... }`；`timeoutMs` 只是声明，注册表不强制。
- `inject` 数组里的每一项都是**硬需求**，缺一项插件就完全不激活（INACTIVE，不报错）。
  可选服务用 `ctx.get(name, false)` 探测，或用 `ctx.inject([...], (ctx) => {})` 建子 fiber。
- 技能有两条贡献路径：`ctx.skills.register(...)`（内存 runtime skill）与
  `ctx.skills.registerProvider(...)`（自定义提供方）。本插件用前者，正文的事实源是
  [`browser-cdp-skill.md`](../product-specs/browser-cdp-skill.md)，生成物是
  `plugins/browser-cdp/skill/index.js`。
- `runtime` 是保留的提供方名；runtime skill 的 `name` 必须是 kebab-case、`description` 必填。
