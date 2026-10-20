# 执行计划：browser-cdp 插件（用 CDP 让智能体驱动真实浏览器）

## 目标

交付一款 DSH 插件：智能体在对话里要操作网页时，能直接驱动一个**真实的 Chromium**——
读 DOM、真实点击与输入、截图、看网络与控制台——而不需要"截图 → 图像识别 → 猜坐标"。

判定完成（可机械核对）：

1. `pnpm check` 全绿（格式 / lint / 类型 / 清单 / 文档 / 密钥 / 测试）。
2. 单元测试覆盖纯逻辑：端口选择、浏览器发现、命令行拼装、CDP 帧解析、按键编码、输出投影。
3. **真实浏览器端到端**：启动 → 导航 → 快照 → 真实点击 → 读回变更 → 中文输入 → 等待 →
   截图 → 标签页 → 关闭（含进程真的退出）。
4. 真实安装验证：装进一个干净 profile 能激活，插件行出现在组合树里，只读路由返回真实状态。
5. 方法论技能随插件注册进会话技能目录，且正文有唯一事实源（生成物由检查保证同步）。

## 背景：为什么不是"接管内置浏览器"

用户最初的设想是"让 DSH Desktop 的内置浏览器开启 CDP"。调研后确认这条路在插件层面不可达，
依据全部来自官方材料与本机安装包（逐条证据见
[`../../docs/references/chromium-cdp-facts.md`](../../references/chromium-cdp-facts.md)）：

- 内置浏览器是 Electron `<webview>` guest，归桌面**主进程**管理；插件运行在
  `ELECTRON_RUN_AS_NODE` 的宿主**子进程**里，没有 Electron API。
- 官方决策记录明确写着该实现"不增加 remote-debugging 端点，也不提供 browser-use 集成"，
  未来自动化提供方需要"已认证、按 target 授权的 broker"。
- `--remote-debugging-port` 是**启动期**开关，运行中的应用无法追加。
- 全字节扫描 `app.asar`：`remote-debugging` / `appendSwitch` / `webContents.debugger` 零命中。
- 本机这一版 App **没有** `dsh-browser-use` 与任何 MCP 提供方（包清单里不存在），
  所以官方 `ctx.browserUse` 体系在本机也没有可用提供方。

结论：走官方认可的形态——**插件自己启动并持有一个 Chromium**。

## 步骤与验证

| 步骤 | 内容                                                      | 验证方式                                                      |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------- |
| 1    | 调研宿主事实、内置浏览器实现、CDP 与 Electron 的硬约束    | 逐条落成事实卡（含出处与复核方法），不靠推断                  |
| 2    | 端口自适应：绑定探测 + 端点探测两级确认                   | 单测覆盖配置容错、候选顺序、跳过被占端口、范围耗尽            |
| 3    | 浏览器发现与进程生命周期（含沙箱回退与失败信息）          | 单测覆盖发现顺序与失败信息；失败路径返回可操作原因            |
| 4    | CDP 传输层（浏览器级 WS + 扁平会话）                      | 单测覆盖帧解析、错误码保留、超时、事件分发与退订              |
| 5    | 页面语义层：导航 / 快照 / 真实点击 / 输入 / 等待 / 截图等 | **真实浏览器 e2e**（`test/e2e/smoke.mjs`）逐步验证            |
| 6    | 工具层：15 个 `browser_*` 工具 + 输出投影                 | 用真实 `defineTool` 构造：schema 与 render 缺一不可，直接暴露 |
| 7    | 技能：方法论正文的事实源 + 生成物 + 检查                  | `sync-skill.mjs --check`；正文关键约定有断言                  |
| 8    | 面板：只读状态路由 + dock 状态条                          | 本机来源才放行（403 判定有测试）；装进真实 profile 后实测     |
| 9    | 文档与注册表：README、规格、事实卡、注册表、生成索引      | `pnpm check` 全绿                                             |
| 10   | 真实安装验证（干净 profile）                              | 组合树里出现插件行；`/plugin/browser-cdp/status` 返回真实状态 |

## 进度

- [x] 步骤 1–9 完成，`pnpm check` 全绿（browser-cdp 62 个测试 + dockyard 16 + plugin-kit 50）
- [x] 真实浏览器 e2e 全流程通过（Chrome 155，端口 24501 探测得出，截图已人工查看）
- [x] 干净 profile 安装验证：插件行进入组合树，状态路由返回 `{"ok":true,...}`，无 import 失败
- [ ] 装进用户实际的 Desktop profile（**需要用户确认**：安装后要重启 DSH 桌面端才生效）
- [x] **装进用户实际的 Desktop profile**（`dsh plugin --profile desktop add`，bundles 已含
      `@dsh-plugins/browser-cdp`）
- [x] **在真实会话里调用成功**：`browser_open`（端口 24000）→ `browser_navigate`
      deepseek.com/harness → `browser_snapshot` / `browser_content` / `browser_console` /
      整页 `browser_screenshot`（1425×4016，已肉眼核对）→ `browser_close`（sigterm，38ms）
- [ ] 多轮、长流程的模型自主使用（需要真实任务，不属于本次交付范围）

## 关于"用内置浏览器"的最终结论（实测，不是推断）

用户明确要求"哪怕黑客手段也要用内置浏览器"，因此把每条路都实测了一遍。结论是
**在插件层面不可能**，只有改 App 本体一条路：

| 尝试                                                              | 实测结果                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `DeepSeek Harness --remote-debugging-port=24000`                  | `bad option: --remote-debugging-port`（Electron 44 的 argv 白名单拒绝）     |
| 换 `--enable-logging` / `--headless=new` / `--user-data-dir`      | 全部 `bad option`                                                           |
| `ELECTRON_EXTRA_LAUNCH_ARGS` / `ELECTRON_ARGS` / `CHROMIUM_FLAGS` | 三种都无效，进程不启动                                                      |
| 把 App 的 Electron 二进制当普通 Chromium 用                       | `bad option` —— 它带自己的参数解析，不是 Chromium 浏览器                    |
| 运行期追加 switch                                                 | 全字节扫描 `app.asar`：`appendSwitch` 0 命中、`webContents.debugger` 0 命中 |
| 从 Client 半侧驱动 Sidebar 的 `<webview>`                         | 官方插件把 element 存为私有字段（`this.element`），无对外访问器；           |
|                                                                   | 只剩 `document.querySelector('webview')` 偷别的插件 DOM —— 本仓库明令禁止   |
| 插件从宿主子进程拿 Electron 对象                                  | 插件跑在 `ELECTRON_RUN_AS_NODE` 的宿主子进程里，没有 `require('electron')`  |

补充事实：本机 App 的捆绑包清单里**不存在** `dsh-browser-use` 与任何 MCP 提供方
（`dsh-browser-use-*`、`dsh-experimental-browser-use-*` 全部缺失），因此官方
`ctx.browserUse` 体系在这台机器上也没有可用提供方。

**因此：** 内置 Sidebar 浏览器要可自动化，必须由 App 自己调用 `appendSwitch`
（即改 `lib/main.js` 并重打包签名，升级即被覆盖）。那是 App 侧改造，不是插件能完成的事。

## 最终决定（用户拍板，2026-10-16）

用户在看到上述实测证据后**放弃操作内置浏览器，采用独立受管 Chromium 实例**。
因此口径统一为"这是已核实的定论"，并同步进了四处事实源：

| 位置                                      | 改成什么                                                              |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `docs/product-specs/browser-cdp-skill.md` | 定位段与"不合适"一节写清三条拦阻 + "不要再试"，并指向 `browser_open`  |
| `docs/product-specs/browser-cdp.md`       | 非目标条目升级为可核对的定论（附事实卡链接）                          |
| `docs/references/chromium-cdp-facts.md`   | 新增"决定记录"表：三条拦阻各自的实测证据 + 未来官方支持时的接入点     |
| `plugins/browser-cdp/README.md`           | 补 asar 完整性/代码签名两条拦阻、**智能体怎么知道该用它**（三层触发） |

技能正文是生成物，改完必须跑 `node plugins/browser-cdp/scripts/sync-skill.mjs`，
一致性由 `pnpm docs:check` 保证（生成物过期即失败）。
另实测：`file:` 依赖在 pnpm 下是硬链接，所以仓库侧改动会在 profile 侧立刻可见。

## 结论与遗留

**已验证：** 工具能被真实 `defineTool` 接受并注册；CDP 链路在真实 Chrome 上完整跑通；
端口是探测出来的；引用号失效会明确报错；进程停止会等到真的退出；插件在干净 profile 与
用户实际 profile 里都能激活，且已在真实会话中被调用成功。

**未验证 / 已知妥协（诚实记录）：**

- 面板的视觉效果没有在真实 UI 里逐项看过（只有代码层面的 token 与结构保证）。
- 长流程的模型自主使用（多轮、跨页面、含登录态的完整任务）没有跑过。
- 跨源 iframe 内的元素不在快照范围内（第一版未做 frame 切换）。
- attach 模式（接入用户已在跑的浏览器）没做：`--remote-debugging-port` 是启动期开关，
  要接入必须由用户自己带开关启动目标浏览器。
- 本机宿主未设置 `DSH_HOME`，因此数据目录落在回退位置 `~/.dsh-plugin-data/browser-cdp`
  （而不是 `$DSH_HOME/plugin-data/browser-cdp`）。可在 profile patch 里显式配置 `dataDir`。
