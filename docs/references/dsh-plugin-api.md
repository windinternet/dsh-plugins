# DSH 插件 API 事实卡

本文件记录编写插件所需的宿主事实。**它从本机安装的 DSH 中提取，不是二手转述。**

| 项       | 值                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| 提取时间 | 2026-10-10；2026-10-21 在 0.2.1-rc.2 上复核槽位与 Client 侧事实并补充                                           |
| 宿主包   | `@deepseek-ai/dsh@0.2.1-rc.2`                                                                                   |
| 来源     | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内的官方技能与包文档                           |
| 原始材料 | `@deepseek-ai/dsh-agent-preset` 的 `cordis-plugin-development` 与 `cordis-composition-reference` 技能           |
| 复核材料 | `dsh-client-ui-plugin-manager` 的 `lib/client.js`、`dsh-client-ui-sidebar` 的 README 与实现、`dsh-desktop-host` |

升级 DSH 后本文件可能过期。重新核对的步骤见文末。

## 插件 = bundle 包

DSH 用 Cordis 作为插件框架。一个可安装的插件就是一个 **bundle**：一个 npm 包，
在其 `package.json` 中声明 `dsh.bundle.patch`，指向一个 YAML patch 文件。
patch 向 profile 的插件行列表里插入行。

Host-only bundle 的最小清单（不需要依赖、构建工具或安装脚本）：

```json
{
  "name": "@dsh-plugins/example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

对应的 `cordis.patch.yml`：

```yaml
- insert:
    - id: example
      name: '@dsh-plugins/example'
      config: {}
```

## Host 半侧导出形态

`index.js` 必须导出下列形态之一，**不要混用**：

- `export function apply(ctx, config) {}`，可选 `export const inject = ['tools']` 与 `export const Config`。
- 一个 service class 作为 default export。

所有资源都必须注册在 `apply` 内部，用 `ctx.effect` 或 `ctx.on`，并返回清理函数。

```js
export const inject = ['tools'];
export const Config = Schema.object({/* ... */});

export function apply(ctx, config) {
  ctx.effect(() => {
    const dispose = ctx.tools.register(/* ... */);
    return () => dispose();
  });
}
```

## Client（UI）半侧

UI 插件在清单里增加 `dsh.client` 段与 `./client` 导出：

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

浏览器产物用全局模块加载器注册一个惰性工厂，**工厂 id 必须等于包名**：

```js
window.__ModuleLoader__.load({
  id: '@dsh-plugins/example',
  factory(require) {
    const React = require('react'); // React 由浏览器模块表提供，勿自行安装或引用 CDN
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'example', order: 5 }, () =>
            React.createElement('div', null, 'hello'),
          ),
        );
      },
    };
  },
});
```

## 界面硬约束

违反这些约束不会在构建期报错，只会在用户侧以难懂的方式失败：

- **禁止 `require` 任何 `@deepseek-ai/dsh-client-*` 包。** 官方文档明确禁止。这些包随时
  变化，纯 JS 插件没有类型检查兜底，且一个抛异常的组件会让整个槽位条目变成空白。
- **样式只用主题 token**（`--dsw-alias-*`）。字面颜色只能用于插画/图标。token 被重命名
  只会让外观退化，不会让渲染崩掉。
- **不要用 iframe 承载插件页面。** iframe 文档拿不到宿主的主题 token、明暗切换与 locale。
- **不要替换应用根节点，也不要往 `document.body` 追加第二个应用。**
- **不要读写其他插件的 DOM、样式表或组件源码。** 需要空间就选一个已经分配好空间的槽位。

## 已确认的槽位名

从宿主客户端产物中提取（出现次数为该名字在宿主代码中的引用次数，可作稳定性参考）：

| 槽位                                  | 用途                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `sidebar.panellist`                   | 左侧栏全局面板入口（root list；`id` 与 `main` 的 key 相同）                   |
| `main`                                | root 作用域的 keyed 全局页；`conversation` 键保留给会话界面                   |
| `sidebar.right.pane.tab`              | 右侧栏标签页（宿主页面级入口常用）                                            |
| `sidebar.right.pane.tab.title`        | 上者的标题                                                                    |
| `sidebar.right.tab.guide.entry`       | 右侧栏引导条目                                                                |
| `sidebar.footer.action`               | 侧栏底部操作区                                                                |
| `settings.general.item`               | 设置「通用」分区条目                                                          |
| `settings.plugins.tab`                | 设置「插件」分区标签页                                                        |
| `plugins.item`                        | 插件管理页的官方插件分组条目                                                  |
| `plugins.bundle.config`               | 插件管理页某个 bundle 的配置区（以包名为 key）                                |
| `plugins.row.config`                  | 插件管理页某一行的配置区（key 形如 `<包名>#<行 id>`）                         |
| `conversation.input.dock`             | 输入框上方停靠区（session 作用域；官方 queue/todo 与状态条用它）              |
| `conversation.composer.dock`          | 输入条内部停靠区（session 作用域；只在 composer 变体且有 session 输入时渲染） |
| `conversation.composer.bar`           | 输入框工具条                                                                  |
| `conversation.session.header.actions` | 会话头部操作区                                                                |
| `conversation.chat.node`              | 会话流中的一个节点（按事件定义的 kind 渲染）                                  |
| `tool.call.toolview`                  | 工具调用的自定义视图                                                          |
| `sidebar.right.tab.document`          | 右侧栏文档预览页                                                              |

宿主自己的管理页（`dsh-client-ui-plugin-manager`）就是通过 `ctx.slots.inject()` 注册
`plugins` 侧栏入口与它的 `main` 面板实现的。新插件应模仿这个模式。

两个 dock 槽位都存在，但渲染条件不同：`conversation.composer.dock` 位于输入条内部，
只在 composer 变体且已有 session 输入时出现；`conversation.input.dock` 位于输入框上方，
只要会话区域在就渲染。要做“一直可见的状态条”，选后者。

### 加一个“左侧栏入口 + 整页”

这是两个槽位配合，不是一个专门的菜单/路由 API：

```js
// 入口：root list。组件是图标，拿到 { size, active }；行与文案由侧栏渲染。
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register(
    { name: 'sidebar.panellist', id: 'example', order: 10, label: () => t('panel'), locale: NS },
    ExampleIcon,
  ),
);

// 页面：root keyed。key 必须等于入口 id，否则点击入口会找不到页面。
ctx.slots.inject('main', () =>
  ctx.slots.register({ name: 'main', key: 'example', locale: NS }, ExamplePage),
);
```

桌面端与 Web 端是同一套 Client：桌面版只是 Electron 外壳加载同一个 web 界面，
因此这两个槽位在两端行为一致。**原生菜单栏**（macOS 顶部应用菜单、Windows 的
Desktop 菜单）由桌面主进程写死，插件加不了；能加的是应用内导航入口。

`dsh.client.inject` 里写 `@deepseek-ai/dsh-client-ui-sidebar` 与
`@deepseek-ai/dsh-client-ui-layout` 只用于激活排序，不会把宿主包装进 profile——
它不是 import，也不是依赖声明。

## 依赖解析：外部插件最大的坑（2026-10-20 修订）

> **这一节的前一版给错了建议，导致过一次真实的启动事故。** 旧结论是"宿主内部包无法凭空解析，
> 所以要把 `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 声明成真实依赖"。
> 那确实能让插件 import 成功，但 pnpm 会把这份副本装进 profile 的 `node_modules`；
> 宿主按**裸包名**解析配置树里的行，profile 里的同名包会抢先命中、遮住宿主自带的那份。
> 宿主升级后精确版本校验失败，`tools` 行被直接禁用，所有工具类插件一起失效。
> 完整根因链与处理步骤见 [`dsh-plugin-upgrade-failure.md`](dsh-plugin-upgrade-failure.md)。

**现行规则（机械检查强制，见 `scripts/verify-plugin-packages.mjs`）：**

1. **插件不得声明任何 `@deepseek-ai/*` 依赖。** `dependencies`、`peerDependencies`、
   `optionalDependencies` 都不行——peer 会被 pnpm 自动安装，同样落进 profile。
2. **需要 `defineTool` / 配置校验这类宿主动能时，用包内实现。**
   本仓库的规范位置是 `packages/plugin-kit/src/`，插件内保留 `src/internal/` 同步副本；
   实现只产出宿主接受的 JSON Schema 子集即可（见 [`dsh-plugin-tools.md`](dsh-plugin-tools.md)）。
3. **需要宿主服务时用 `ctx.inject` / `ctx.get`**：这些是运行期传入的对象，不引入任何包。
4. **兼容性用 `engines.dsh` 声明**（例如 `"^0.2.0-rc.2"`）。宿主 0.2.1 起会在启动/安装时
   按它做版本裁决，给出明确提示而不是让启动挂在半路。
5. **安装用 `file:` 或 registry spec，不能用 `link:`**；`workspace:*` 在外部 profile 里
   必然失败（`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`）。

**验证依赖是否干净：** 安装后看 profile 目录——`node_modules/@deepseek-ai/` 应当不存在或为空。
一旦出现内容，说明还有插件在声明宿主包依赖，下一次宿主升级就会重演事故。

### 服务属性必须先声明再读

`ctx.<service>` 的读取受 inject 约束：未声明的服务属性会抛
`cannot get property "X" without inject`，而**这个错误发生在激活期**，插件直接不激活。

- 必需的服务：静态声明 `export const inject = ['tools']`。
- 可选的服务（例如 `webServer`、`logger`）：用 `ctx.inject(['webServer'], (ctx) => { ... })`
  建一个子 fiber，服务可用时才运行。不要用 `ctx.webServer ? ...` 去探测。
- `ctx.baseDir` 之类也不能直接读。需要路径时用环境变量（`DSH_HOME`）与 `os.homedir()` 推导。
- 想读服务而不想引起激活依赖，可以用 `ctx.get('logger', false)`。

## 安装与启用

安装走 DSH 的 `plugin_manager`，`action: install_bundle`，`target` 为插件包的绝对目录。
它会完成包安装与 bundle 选择，**不要**手工复现这些步骤：

- 不要写 profile 的 `package.json` 或 `cordis.patch.yml`。
- 不要在 `$DSH_HOME` 下创建包。
- 不要在 profile 目录里运行 pnpm。
- 只有用户明确批准了 pending build scripts 之后，才传 `approvedBuilds`。

判断改动是否生效，看安装结果里的 `application` 与 `warnings` 字段，而不是服务端日志、
终端输出或进程列表。用 `cordis_inspect_query` 确认新行（它不需要审批）。

## 扩展点强弱排序

从最弱到最强，**优先用最弱的那个**：

1. `ctx.tools.restrict()`——只能移除工具。
2. `ctx.tools.guard()`——只能拒绝，同步。
3. waterfall 监听器（`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、
   `tools/execute`、`tools/post-execute`）——可改写，依赖注册顺序。
4. `system-prompt/assemble`——替换整个装配结果，需要自己保住其他插件的贡献。

不拥有该决策的 waterfall 监听器必须 `return next()`。

## 几条容易踩的坑

- **会话日志是唯一事实源。** 模型能看到的一切都必须能从已提交的会话事件重建。
  不要用新 `type` 追加会话事件：读取方只在信封带 `ignorable: true` 时才接受未知事件，
  而运行期 `Session.append()` 无法设置该标记，会话将无法重新打开。
- **不要把逐会话状态做成 `session/event` 监听 + 重扫 `session.events`。** 用
  `ctx.sessionProjections` 单元；`apply(state, event)` 必须是纯函数且同步。
- **注册的所有权要明确。** 注册在 `agent.ctx` 上的东西有两个所有者：既要在插件的
  effect 里留 disposer，也要包在 `agent.ctx.effect()` 里，这样任一方卸载都能清干净。
- **可选服务放进 `inject`**，让插件在没有该服务的 profile 里保持未激活，而不是抛异常。
- **可调参数放进 `Config`**，用户改 `cordis.patch.yml` 即可，那份 patch 层能挺过升级。

## 重新核对本文件的步骤

```bash
APP="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
# 1. 确认宿主版本
node -e '...'   # 读取 app.asar 内 /dsh/package.json 的 version
# 2. 重新导出官方技能
#    @deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/
#    @deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/
# 3. 对照 references/practices.md 与 templates/ 更新本文件
```

提取脚本的要点：asar 的 header 是 pickle 编码，数据区偏移需要用 `16 + headerSize + 2`
（这个 `+2` 是 pickle 对齐，容易搞错）。
