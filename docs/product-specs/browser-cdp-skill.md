---
name: browser-cdp
description: 用 CDP 驱动真实 Chromium 完成 web 相关的任务——自动化测试、抓取渲染后的页面、复现线上问题、验证自己写的前端改动、走通需要登录的交互流程。
whenToUse: 任务涉及真实网页的打开、点击、填表、截图、读取渲染后内容或调试页面行为时。
---

# 用 CDP 驱动真实浏览器

## 这套能力的定位

浏览器工具在本机启动一个**受管的 Chromium 实例**，通过 CDP（Chrome DevTools Protocol）
直接控制它。这意味着：

- **不是**"截图 → 图像识别 → 猜坐标 → 模拟鼠标"。位置来自 DOM 的真实几何信息，
  点击是真的 `Input.dispatchMouseEvent`，读内容是读渲染后的 DOM。
- **不是** `web_fetch`。这里是真实浏览器：JS 会执行、SPA 会渲染、Cookie 与登录态会保留。
- **是**一个独立实例：有自己单独的 profile 目录，和你日常用的浏览器完全隔离，
  不会抢你的窗口、不会碰你的登录态。CDP 端点只在 `127.0.0.1` 上，端口由插件探测后固定。

**关于 DSH 内置的 Sidebar 浏览器（已核实，不要再试）：** 那是这个 Electron 实例里的一个
`<webview>` guest，要自动化它就得让**整个 Electron 实例**开 CDP——插件做不到，因为
（1）插件跑在宿主子进程里，拿不到 `app.commandLine`；（2）`--remote-debugging-port` 是启动期
开关，插件加载时浏览器早就起来了；（3）直接改 `lib/main.js` 会被 asar 完整性校验与代码签名拦住。
即便绕过这些、从界面侧去驱动那个 `<webview>`，你也**没有 CDP**，等于放弃截图、网络、控制台与
无障碍树——换来的只是"看起来一体化"。所以本插件的形态就是**自己起一个受管实例**：
`browser_open`，然后所有 `browser_*` 工具都作用在它上面。

## 事实：CDP 的几条硬约束（记住这些，能少走很多弯路）

- **`--remote-debugging-port` 只能在进程启动时给。** 运行中的浏览器无法追加这个开关，
  所以受管实例必须由插件自己启动。想接管一个"已经在跑的"浏览器是做不到的。
- **一个 profile 只能被一个浏览器进程占用。** 这是保护机制：插件永远用自己的
  `--user-data-dir`，因此永远不会劫持用户正在用的浏览器。
- **`--headless=new` 是现行无头实现**；`--headless=old` 只在旧版本上需要。
  无头模式下视口由 `--window-size` 决定，所以"响应式布局"的测试要显式给窗口尺寸。
- **引用号（ref）会失效。** 它是在快照那一刻打在 DOM 元素上的标记，
  页面一旦导航或被重新渲染，旧 ref 就找不到了。失效时**必须重新快照**，
  而不是换一个选择器硬点——那正是"看起来点了但什么都没发生"的根源。
- **CDP 是浏览器内置能力，不是自动化库。** 没有 Playwright 那种"自动等待元素可点击"
  的魔法：该等的要显式等（`browser_wait`），该确认的要回读（工具结果里已经带了页面状态）。

## 工作循环

1. **先看，再动。** `browser_open` → `browser_snapshot`。快照给出可交互元素清单与引用号，
   这是后续所有动作的定位来源。
2. **一次一个动作。** 每个动作工具都会返回动作后的页面状态、最近控制台消息与失败请求。
   **先读这些再决定下一步**——多数"没生效"在这一步就能看出来，不需要额外调用。
3. **该等就等。** 动作后内容没出来时用 `browser_wait`（等选择器、等文本、或等网络静默），
   不要用 `browser_eval` 里 `setTimeout` 硬睡。
4. **失败要区分是"没找到"还是"还没到"。** 引用号失效 ⇒ 重新快照；
   元素存在但不可见 ⇒ 先滚动（工具会自动滚动到视口中心并告知你）；
   `ok: true` 但页面没变 ⇒ 看控制台与失败请求，通常是页面自己报错了。

## 选哪个工具

| 想做的事                     | 用                                                           |
| ---------------------------- | ------------------------------------------------------------ |
| 打开页面 / 启动浏览器        | `browser_open`                                               |
| 跳到另一个地址               | `browser_navigate`                                           |
| 找可点的东西、拿引用号       | `browser_snapshot`                                           |
| 读正文、核对文案、抓列表     | `browser_content`                                            |
| 读某个元素的 value/属性/显隐 | `browser_get`                                                |
| 点击（真实鼠标事件）         | `browser_click`                                              |
| 填表单                       | `browser_type`（`submit: true` 直接回车提交）                |
| 按 Esc / Tab / 组合键        | `browser_key`                                                |
| 等内容出现/消失              | `browser_wait`                                               |
| 给人看或做像素级验证         | `browser_screenshot`（返回文件路径，可用 `read_image` 查看） |
| 页面内的复杂查询或调 API     | `browser_eval`                                               |
| 排查"为什么没出来"           | `browser_network`、`browser_console`                         |
| 多标签                       | `browser_tabs`                                               |
| 收工                         | `browser_close`                                              |

## 定位元素：优先 ref，其次 selector

- **ref 是首选。** 它来自真实快照，对"页面上有多个同名按钮"这类情况天然无歧义。
- **selector 适合稳定的结构性锚点**（`#login-form input[name=email]`），
  不适合自动生成的 class（`css-1x2y3z` 这种改一次构建就变）。
- **坐标是最后手段**，只在没有 DOM 依据时用（canvas、地图、游戏）。
  用坐标意味着放弃了所有语义信息，后续任何布局变化都会让脚本失效。
- 输入类元素要给**唯一标识**：`name`、`type`、`placeholder`，或所在的表单容器。

## 等待的正确姿势

- 页面没渲染完 → `browser_wait { selector }`。
- 提交表单/点了按钮之后 → `browser_wait { text: "成功" }` 或等目标选择器出现。
- SPA 路由切换 → `browser_wait`（不给条件即按网络静默判断）。
- **超时不是错误，是事实。** 超时后先 `browser_snapshot` 看页面到底在哪一步，
  再决定是放宽超时（`timeoutMs`）还是修正定位——不要盲目重试同一件事。

## 调试：先看网络与控制台，再怀疑工具

- 页面空白/样式丢失 → `browser_network { onlyFailures: true }`：CORS、404、混合内容、证书问题
  都会在这里显形。
- 点击无反应 → `browser_console`：未捕获异常与 React/Vue 的运行时错误会直接告诉你原因。
- 需要更多细节 → `browser_eval` 读 `document.querySelector(...)` 的状态、
  `performance.getEntriesByType('resource')`、`localStorage` 之类。
- 请求本身没问题但数据不对 → 用 `browser_eval` 里的 `fetch` 复现，把响应和页面里的状态对照。

## 上下文效率

- 别对整个页面反复 `browser_content`：用 `selector`/`ref` 限定范围，或先快照再读单个元素。
- 截图会落盘并返回路径。**只在需要看视觉时**才用小图；能用文本确认的就别截图。
- `browser_network` / `browser_console` 都有 `limit`，先看失败项（`onlyFailures` / `onlyErrors`）。

## 隔离与安全边界

- 受管实例有独立 profile：**你的日常浏览器的 Cookie、扩展、登录态都不会被用到**。
  需要登录态的自动化流程，得在这个实例里登录一次（profile 会保留，下次启动还在）。
- 被访问的页面就是普通网页，没有任何额外权限。页面的 JS 不能读本机文件、
  也不能通过这个通道反过来操作宿主的 DSH。
- 插件不会为了绕过反自动化检测而伪装指纹。站点明确拒绝自动化时，尊重它。

## 什么时候这套东西不合适

- 只用静态 HTML 就够 → `web_fetch` 更省。
- 需要极端的反检测绕过、需要 Firefox/WebKit 引擎、需要分布式并发浏览器农场 →
  这不是本工具的定位，别硬拗。
- 需要自动化"DSH 内置浏览器那个标签页" → **做不到，已定论**（见上文三条原因）。
  要自动化就用受管实例：`browser_open`。
