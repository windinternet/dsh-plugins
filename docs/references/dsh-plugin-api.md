# DSH 插件 API 事实卡

本文件记录编写插件所需的宿主事实。**它从本机安装的 DSH 中提取，不是二手转述。**

| 项       | 值                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------- |
| 提取时间 | 2026-10-10                                                                                            |
| 宿主包   | `@deepseek-ai/dsh@0.2.0-rc.2`                                                                         |
| 来源     | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内的官方技能与包文档                 |
| 原始材料 | `@deepseek-ai/dsh-agent-preset` 的 `cordis-plugin-development` 与 `cordis-composition-reference` 技能 |

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
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'example', order: 5 }, () =>
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

| 槽位                                  | 用途                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| `sidebar.right.pane.tab`              | 右侧栏标签页（宿主页面级入口常用）                    |
| `sidebar.right.pane.tab.title`        | 上者的标题                                            |
| `sidebar.right.tab.guide.entry`       | 右侧栏引导条目                                        |
| `sidebar.footer.action`               | 侧栏底部操作区                                        |
| `settings.general.item`               | 设置「通用」分区条目                                  |
| `settings.plugins.tab`                | 设置「插件」分区标签页                                |
| `plugins.item`                        | 插件管理页的官方插件分组条目                          |
| `plugins.bundle.config`               | 插件管理页某个 bundle 的配置区（以包名为 key）        |
| `plugins.row.config`                  | 插件管理页某一行的配置区（key 形如 `<包名>#<行 id>`） |
| `conversation.composer.dock`          | 输入框下方停靠区（官方模板默认选它）                  |
| `conversation.composer.bar`           | 输入框工具条                                          |
| `conversation.session.header.actions` | 会话头部操作区                                        |
| `conversation.chat.node`              | 会话流中的一个节点（按事件定义的 kind 渲染）          |
| `tool.call.toolview`                  | 工具调用的自定义视图                                  |
| `sidebar.right.tab.document`          | 右侧栏文档预览页                                      |

宿主自己的管理页（`dsh-client-ui-plugin-manager`）就是通过 `ctx.slots.inject()` 注册
`plugins` 侧栏入口与它的 `main` 面板实现的。新插件应模仿这个模式。

## 依赖解析：外部插件的最大陷阱

这一节是**实测结论**，不是推断。踩过一次，记在这里避免重复。

**外部插件无法凭空解析宿主内部包。** Node 的解析链从插件的 `node_modules` 往上走，
到不了 DSH 安装目录里的 `app.asar/dsh/node_modules`，部署里也没有会补上这一步的投影目录。
现象是安装看起来成功，启动时报一行 `failed to import`，没有更详细的错误。

因此：

1. **`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 这类包必须声明为真实依赖**，
   带精确版本，与宿主基线一致（当前 `dsh-tools@0.2.0-rc.2`、`schemastery@3.18.4`）。
   它们在公开 npm 上有发布（`next` 标签）。
2. **安装时必须用 `file:` 或 registry spec，不能用 `link:`。**
   `link:` 只建立符号链接，**不会解析该包的依赖树**，依赖仍然缺失。
3. **`workspace:*` 在外部 profile 里必然失败。** profile 的 pnpm workspace 只包含它自己，
   报错是 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。插件要能独立安装，就不能依赖工作区协议。

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
