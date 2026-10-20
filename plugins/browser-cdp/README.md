---
description: '让智能体用 CDP 直接驱动一个受管 Chromium：自适应端口、独立 profile、结构化页面操作与截图，并随插件提供方法论技能。'
kind: 'package-reference'
---

# @dsh-plugins/browser-cdp

## 概述

把"智能体要用浏览器"这件事从**看图猜坐标**变成**读 DOM 说人话**。

它做的事情很直接：在本机启动一个开启 CDP（Chrome DevTools Protocol）的 Chromium 实例，
然后用协议去导航、读页面、点按钮、填表单、截图、看网络与控制台。位置来自真实几何信息，
点击是真的 `Input.dispatchMouseEvent`，读的是渲染之后的 DOM——不是截图识别，也不是 HTTP 抓取。

数据流向：**仅本机**。浏览器进程、profile、截图都在本机文件系统；CDP 通道是 `127.0.0.1`
上的回环 WebSocket。被访问的网页自身会联网，那是浏览器在被使用，插件不向任何第三方发数据。

## 一件必须先说清楚的事（已核实，不要再试）

**DSH Desktop 内置的那个"浏览器"标签页，插件无法自动化。** 这不是暂缓，是定论：

- 它是 Electron 的 `<webview>` guest，由桌面**主进程**管理，guest 分区是随机的、非持久的。
- 官方决策记录写明该实现"不增加 remote-debugging 端点，也不提供 browser-use 集成"，
  未来的自动化提供方需要"已认证、按 target 授权的 broker"。
- 插件运行在 `ELECTRON_RUN_AS_NODE` 的宿主**子进程**里，没有 `require('electron')`，
  拿不到 `webContents`；`--remote-debugging-port` 又是启动期开关，运行时无法追加。
- 全字节扫描 `app.asar`（121 MB）：`remote-debugging` / `appendSwitch` / `webContents.debugger`
  **零命中**。

还有两条同样致命：`--remote-debugging-port` 是**启动期**开关（插件被加载时浏览器早在跑了），
而直接改 `lib/main.js` 会被 **asar 完整性校验**（`Info.plist` 里的 `ElectronAsarIntegrity`
SHA256）与 **Developer ID 代码签名**拦住。即便从界面侧绕过去驱动那个 `<webview>`，
也拿不到 CDP——等于放弃截图、网络、控制台与无障碍树。

所以本插件走的是官方认可的形态——**自己启动并持有一个 Chromium**（官方 `ctx.browserUse`
下的三个提供方也全是这个形态，只是它们依赖外部 MCP 服务器）。逐条证据、复核方法与
完整的决定记录见
[`docs/references/chromium-cdp-facts.md`](../../docs/references/chromium-cdp-facts.md)。

## 使用本包

### 安装

插件**没有任何依赖**——这也是它能安全跨宿主升级的原因。安装用 `file:` 或 registry spec：

```bash
dsh plugin --profile desktop add "file:/绝对路径/dsh-plugins/plugins/browser-cdp"
```

用 `link:` 只会建符号链接、不解析依赖树，插件启动时会以一行 `failed to import` 失败。

**千万不要把 `@deepseek-ai/*` 宿主包写进依赖。** 上一版曾把 `dsh-tools` / `schemastery`
声明成普通依赖，pnpm 把它们装进了 profile；宿主升级到 0.2.1 后精确版本校验失败，
`tools` 行被禁用，整个桌面端起不来。根因链与处理步骤见
[`docs/references/dsh-plugin-upgrade-failure.md`](../../docs/references/dsh-plugin-upgrade-failure.md)。
现在这条由 `pnpm verify:plugin-packages` 机械强制。

**开发时的一个坑（实测）：** pnpm 对 `file:` 目录依赖做的是**安装时的文件清单快照**，
其中已存在的文件用硬链接指向仓库里的同一份内容，所以：

- **改已有文件的内容** → profile 侧立刻可见，不必重装（两边共享 inode，**别在 profile 里改**）。
- **新增或删除文件** → **不会同步**。`pnpm add` 看到 `file:` spec 没变会说
  "Already up to date"，此时必须 `remove` + `add`（或先提升插件版本）才会重新取快照。
  实际踩过：新增 `src/internal/config.js` 后 profile 仍缺文件，插件以 `failed to import` 失败。

工具定义编译与配置归一化在包内实现（`src/internal/`）。整包零依赖：
CDP 走 Node 内置的全局 `WebSocket`，进程走 `node:child_process`。
不打包 Playwright、不打包 Puppeteer、不需要单独装 MCP 服务器。

### 给智能体的工具

十四个工具，全部以 `browser_` 开头：

| 工具                 | 作用                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `browser_open`       | 启动/复用受管浏览器并打开页面，返回真实端口、浏览器版本与页面状态。 |
| `browser_navigate`   | 导航到地址，等到 DOM 可交互或 load。                                |
| `browser_snapshot`   | 列出可交互元素（带引用号、文本、标签、是否在视口内）。              |
| `browser_content`    | 读页面（或指定元素）的可见文本 / HTML。                             |
| `browser_get`        | 读单个元素的 value、属性、显隐、几何位置。                          |
| `browser_click`      | 真实鼠标事件点击（引用号 / 选择器 / 坐标）。                        |
| `browser_type`       | 真实输入路径填表，支持中文与回车提交。                              |
| `browser_key`        | 发送具名键与组合键。                                                |
| `browser_wait`       | 等选择器出现、等文本出现，或等网络静默。                            |
| `browser_screenshot` | 截图落盘，返回路径与尺寸（配 `read_image` 看）。                    |
| `browser_eval`       | 在页面里执行 JS（支持 await）。                                     |
| `browser_network`    | 读记录到的请求与失败原因。                                          |
| `browser_console`    | 读控制台消息、未捕获异常与浏览器日志。                              |
| `browser_tabs`       | 列出 / 新建 / 切换 / 关闭标签。                                     |
| `browser_close`      | 关掉浏览器并确认进程真的退出。                                      |

典型用法：`browser_open` → `browser_snapshot` → `browser_click` → 读动作结果里的页面状态。
动作类工具都会回读页面状态、最近控制台消息与失败请求，因此"成了没有"当场就能判断，
不需要额外再发一轮调用去确认。

### 智能体怎么知道该用它

三层触发，都是机械的、不靠"记得"：

1. **工具描述**：十五个 `browser_*` 工具在每一轮请求里都可见，描述直接写明"涉及真实网页时用我"。
2. **技能目录**：`browser-cdp` skill 的 `description` 与 `whenToUse` 由宿主渲染进会话技能目录——
   任务涉及"打开/点击/填表/截图/抓渲染后页面/调试页面行为"时就会被选中。
3. **技能正文**：按需加载，讲的是方法论（先看再动、ref 与 selector 的取舍、等待姿势、
   调试先看网络与控制台、上下文效率、以及为什么不用内置浏览器）。

三层里任何一层单独都够用；同时存在是为了让"没触发"变成不可能，而不是让模型去猜。

### 技能

插件通过 `ctx.skills.register(...)` 注册一个 runtime skill（名为 `browser-cdp`），
正文是方法论：先看再动的工作循环、ref 与 selector 的取舍、等待的正确姿势、
调试先看网络与控制台、上下文效率、隔离边界。

正文的事实源是 [`docs/product-specs/browser-cdp-skill.md`](../../docs/product-specs/browser-cdp-skill.md)，
生成物是 `skill/index.js`：

```bash
node plugins/browser-cdp/scripts/sync-skill.mjs          # 重新生成
node plugins/browser-cdp/scripts/sync-skill.mjs --check   # 校验一致性
```

改方法论请改 Markdown，然后重新生成——两份手写副本一定会漂移。

### 界面

输入框下方的停靠区显示一行状态：`browser-cdp · 运行中 · 端口 24000`。
浏览器是**懒启动**的——首次调用任一 `browser_*` 工具时才启动，所以应用刚启动时这行显示
`browser-cdp · 浏览器未启动`。这是**浏览器**的状态，代表插件已激活但还没有页面需要它。
点击展开显示浏览器版本、CDP 端点、profile 目录、当前页面与已记录的请求/控制台条数。
状态接口不可用时显示明确提示，而不是空白。

面板数据来自只读同源路由 `/plugin/browser-cdp/status`，**只接受回环来源**（其他地址 403），
且不返回 CORS 头，因此跨站页面读不到本机浏览器信息。

面板**刻意不做启停按钮**：浏览器归插件所有，启停由智能体的工具驱动；
面板多一套控制路径只会多一处状态不一致。

## 配置

配置写在 profile 的 `cordis.patch.yml` 里。插件刻意**不导出 schemastery 的 `Config`**
（原因见上文依赖说明），因此宿主的插件设置页不会为它渲染字段表单；
字段类型不合法时插件不会拒绝启动，而是回退默认值并在日志里记一条诊断。

| 字段                  | 默认值                                                                                           | 含义                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `dataDir`             | `$DSH_HOME/plugin-data/browser-cdp`（宿主未设 `DSH_HOME` 时为 `~/.dsh-plugin-data/browser-cdp`） | 数据目录（profile 与截图都在这下面）。                     |
| `executablePath`      | 自动发现                                                                                         | 显式指定浏览器可执行文件。                                 |
| `browserPaths`        | `[]`                                                                                             | 额外候选路径，按顺序尝试。                                 |
| `portRange`           | `24000-24060`                                                                                    | CDP 端口范围，支持 `[lo, hi]` 或 `"lo-hi"`。               |
| `headless`            | `true`                                                                                           | 是否无头。设为 `false` 会有可见窗口，便于人观察。          |
| `headlessMode`        | `new`                                                                                            | `new` / `old`；旧版本浏览器可能需要 `old`。                |
| `allowSandbox`        | `false`                                                                                          | 是否保留浏览器自身沙箱。见下文"沙箱回退"。                 |
| `chromiumArgs`        | `[]`                                                                                             | 追加的命令行参数，原样透传。                               |
| `windowSize`          | `[1440, 900]`                                                                                    | 初始窗口尺寸（无头模式下决定视口）。                       |
| `commandTimeoutMs`    | `30000`                                                                                          | 单条 CDP 命令超时。                                        |
| `stopBrowserOnUnload` | `true`                                                                                           | 插件卸载时是否关掉浏览器（默认关，避免留下占端口的孤儿）。 |
| `enablePanelRoute`    | `true`                                                                                           | 是否注册状态面板路由。                                     |
| `enableSkill`         | `true`                                                                                           | 是否注册方法论技能。                                       |

## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 为什么端口要两级确认

端口空闲不等于端口上是我们想要的浏览器。所以选端口是两步：先在回环地址上真正 `listen`
一次（唯一可靠的"空闲"证据），启动后再问到 `/json/version`（确认它确实是 DevTools 端点）。
默认范围 `24000-24060` 刻意避开 9222（他人常用）与 3000/5173/8000（开发服务常用）。

### 为什么一定要独立 profile

不给 `--user-data-dir` 时，新进程会与用户正在运行的 Chrome 合并或直接退出，调试端口不会
出现在我们期望的进程上。给独立 profile 有两个好处：一是真正独立可控；
二是**永远不可能劫持用户自己的浏览器**（一个 profile 只能被一个进程占用）。
代价是它不共享用户的登录态——需要登录态的自动化流程要在受管实例里登录一次，
profile 会保留，下次启动还在。

### 沙箱回退是怎么回事

本机实测：在受限执行环境里，Chromium 渲染进程会立刻 `SIGTRAP`，三种模式
（GUI / `--headless=new` / `--headless=old`）表现一致——DevTools HTTP 端点起得来，
但 attach 之后所有页面级命令超时。加 `--no-sandbox` 后全部正常。

所以策略是：**先按正常方式启动 → 检测到进程没活下来 → 关闭浏览器沙箱重试一次 →
把这次回退如实写进返回值**。而不是默认就关沙箱（那是无谓的降级），
也不是静默降级（那会让人不知道为什么"就是这么设的"）。

想强制保留沙箱：`allowSandbox: true`。

### 为什么工具是十四个而不是三个

每个工具对应一个**语义明确的动作**，而不是把导航/点击/输入塞进一个"万能动作"工具。
理由是可发现性与可恢复性：模型看到的是十四个名字与描述，选错时错误信息能直接指出
"引用号失效，请重新快照"；而万能工具的错误只会是一句模糊的参数校验失败。
代价是工具定义占用上下文——通过精简描述与把方法论放进按需加载的技能来抵消。

### 动作后为什么必定回读

每次点击/输入都会返回动作后的页面状态、最近 5 条控制台消息与失败请求。
这不是顺手加的：没有它，模型必须再发一次 `browser_snapshot` 才能知道动作成没成，
而"点了没反应"绝大多数时候在控制台里就有答案（未捕获异常、失败的 fetch）。

### 引用号（ref）的语义

快照时给每个可见的可交互元素打上 `data-dsh-browser-ref="eN"`，后续动作靠这个属性找回元素。
页面一旦导航（`Page.frameNavigated`）或重新快照，旧的 ref 全部作废——这是**唯一权威的失效信号**。
ref 失效时报错会明确要求重新快照，绝不"换一个选择器硬点"。

### 进程归属

浏览器进程归插件所有，`detached: false`，随宿主进程生命周期管理。插件卸载时默认关闭它
（`stopBrowserOnUnload: true`）——一个占着端口、没人认领的浏览器进程是最糟的遗留状态。
停止是一个过程：温和终止 → 轮询确认 → 超时强杀 → 再确认，两步都超时才报告"状态不可信"。

</details>

## 模型体验

Agent 看到十四个 `browser_*` 工具的名称、描述与参数 schema；装了技能时还能看到
`browser-cdp` 技能的摘要，并在需要时加载完整方法论正文（约 4.4 KB）。

### Token 影响

- 装配时提供十四个工具声明 + 一条技能摘要。
- `browser_snapshot` 的结果是紧凑的制表符分隔表（引用号 / 标签 / 文本），元素数上限 150。
- `browser_content` 默认上限 20000 字符，可再收窄。
- **截图不进入上下文**：图片落盘、只返回路径。这是故意的——工具结果的展示内容只支持文本块，
  而且几十 KB 的 base64 会把上下文灌爆。
- `browser_network` / `browser_console` 默认各返回最近 50 条，支持 `onlyFailures` / `onlyErrors`。

### KV Cache 影响

工具目录固定，不随调用变化，因此前缀稳定。工具结果追加到历史；
技能正文按需加载一次，之后不再变动。

## 已知限制

- **不能驱动 DSH 内置 Sidebar 浏览器。** 见上文，官方无此接缝。
- **不保证通过所有反自动化站点。** 受管实例是标准 Chromium，行为可被检测；
  本插件不做指纹伪装。
- **只支持 Chromium 系。** Firefox / WebKit 不支持（CDP 是 Chromium 的协议）。
- **不受管的浏览器接不进来。** `--remote-debugging-port` 是启动期开关，
  运行中的浏览器无法追加；想接入已有实例必须由用户自己带这个开关启动它
  （本插件第一版不做 attach 模式）。
- **多会话共享同一个浏览器实例。** 浏览器归插件所有，两个会话同时操作同一页面时
  后到者覆盖先到者。这是本机单用户工具的合理边界，不是 bug。
- **同源 iframe 可见，跨源 iframe 不可见。** 快照只在顶层文档里查找元素；
  跨源 iframe 内部需要单独处理（第一版未提供 frame 切换）。
- **视觉验证未完成。** 状态面板只用主题 token，但没有在真实浏览器里逐项看过；
  槽位注册与折叠交互只有代码层面的保证。
- **模型调用未端到端实测。** 工具注册与 CDP 链路已用真实浏览器验证（见 `test/e2e`），
  但"真实模型在多轮对话里连续使用这套工具"还没有跑过完整案例。

## 失败行为

| 情况                           | 处理方式                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------- |
| 找不到浏览器                   | 列出所有查找过的路径，并提示安装或配置 `executablePath`。                       |
| 端口范围内无可用端口           | 明确报出试过多少个端口，不静默换到范围外。                                      |
| 渲染进程起不来                 | 关闭浏览器沙箱重试一次，并在返回值里说明发生了回退。                            |
| 浏览器被用户手动关掉           | 下一次调用察觉进程已退出，报"先重新 `browser_open`"，不谎报运行中。             |
| 引用号失效                     | 报错并要求重新 `browser_snapshot`，不猜位置。                                   |
| 导航失败（DNS/TLS/超时）       | 原样带出 `net::ERR_*` 原因，区分"站点不可达"与"工具坏了"。                      |
| 页面 JS 抛错                   | 作为观测结果返回（`browser_eval` 报错、`browser_console` 记录），不让工具崩溃。 |
| 状态接口不可用（无 HTTP 服务） | 记一条警告，面板显示不可用提示，工具不受影响。                                  |
| 关闭后进程仍未消失             | 报告"状态不可信"，不谎报成功。                                                  |

## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

- 纯逻辑在 `src/`（端口、发现、进程、CDP 传输、页面语义），宿主适配在 `index.js`，
  界面在 `client.js`，工具定义在 `src/tools.js`。
- 分层原则：`src/tools.js` 只做参数声明、调用 `session`、渲染文本，
  **不写任何页面语义**；语义全在 `src/session.js`。
- 运行测试：`pnpm --filter @dsh-plugins/browser-cdp test`
- 端到端（真的开浏览器）：`node plugins/browser-cdp/test/e2e/manual-smoke.mjs`
- 全量检查：`pnpm check`
- 改了技能正文后务必跑一次 `node plugins/browser-cdp/scripts/sync-skill.mjs`，
  否则 `pnpm docs:check` 会失败。
- 关于宿主工具 API 的事实（`defineTool` 需要哪些字段、`execute` 返回什么、
  `output.render` 产出什么）记录在
  [`docs/references/dsh-plugin-tools.md`](../../docs/references/dsh-plugin-tools.md)，
  那是从本机安装包提取并逐条核对过的。

</details>
