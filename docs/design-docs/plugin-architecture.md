# 插件机制

本文件说明一个插件在本仓库里如何组织，以及两半侧之间的契约。
宿主 API 的原始事实见 [`../references/dsh-plugin-api.md`](../references/dsh-plugin-api.md)。

## 一次加载发生了什么

```text
用户安装插件
   │  plugin_manager.install_bundle(target = 插件绝对路径)
   ▼
profile 的 package.json 增加依赖 ──▶ cordis.patch.yml 增加一行
   │
   ▼
Cordis Loader 组装插件行
   │
   ├─▶ Host：import 插件包的 index.js，调用 apply(ctx, config)
   │      插件在这里注册工具、监听事件、启动它拥有的资源
   │
   └─▶ Client（若声明了 dsh.client）：
          宿主把插件包的 ./client 加入浏览器模块图，
          浏览器侧调用 window.__ModuleLoader__.load({ id: 包名, factory })
          factory 返回 { inject, apply }，apply 里做槽位注册
```

关键点：**Host 与 Client 的关联靠包名**。`dsh.client` 段与 `./client` 导出都必须在同一个
`package.json` 上，所以两半侧同包不同文件，而不是分开两个包。

## 目录约定

一个插件的标准布局：

```text
plugins/<id>/
├─ package.json        清单：name、exports、dsh.bundle.patch、dsh.client
├─ cordis.patch.yml    bundle patch：向 profile 插入插件行
├─ index.js            Host 半侧：apply(ctx, config)
├─ client.js           Client 半侧：__ModuleLoader__.load 工厂
├─ README.md           给人看的使用说明与数据流向声明
├─ icon.svg            插件卡片图标（可选，但强烈建议）
├─ locale/
│  ├─ en.json          展示元信息（标题、描述）
│  └─ zh.json
├─ src/                插件的内部实现，被 index.js / client.js 引用
│  └─ ...
└─ test/               本插件的行为测试
```

`index.js` 与 `client.js` 保持薄：它们是**适配层**，负责与宿主 API 对接；
真正的逻辑放进 `src/`。这样可以单独测试逻辑，不必启动宿主。
这也正是"深模块"的做法：对外是一个窄接口，内部容纳主要复杂度。

## Host 半侧契约

0. **插件不依赖任何宿主包。** 只依赖 Node 内置模块与自己包内的实现；
   需要工具定义、配置校验这类能力时用 `src/internal/` 的同步副本。
   宿主升级导致的启动事故复盘见
   [`../references/dsh-plugin-upgrade-failure.md`](../references/dsh-plugin-upgrade-failure.md)。
1. **`apply(ctx, config)` 是唯一入口。** 不做任何模块级副作用——模块加载不等于激活。
2. **每个资源都有 disposer。** 用 `ctx.effect` 注册，返回清理函数；用 `ctx.on` 监听事件。
   插件卸载、会话销毁都会调用它们。资源泄漏在长跑的宿主进程里代价很高。
3. **配置走 `Config`。** 声明 `export const Config` 后，宿主会校验该行的 `config`。
   用户通过 `cordis.patch.yml` 覆盖，那份 patch 层能挺过插件升级。
4. **可选依赖走 `inject`。** 声明后，插件在缺少该服务的 profile 里保持未激活，
   而不是抛异常。
5. **不要自己订阅再全量重扫。** 逐会话状态用 `ctx.sessionProjections`；
   框架已经做了订阅、缓存与增量发布，自己写一遍只会绕过这套机制。

## Client 半侧契约

1. **工厂必须无副作用。** `factory()` 只做定义与返回，注册放在返回的 `apply(ctx)` 里。
2. **id 必须等于包名。** 宿主用包名索引浏览器半侧。
3. **只用 `ctx.slots.inject` + `ctx.slots.register` 参与界面。** 不要操作组件外的 DOM，
   不要往 `document.body` 追加内容。
4. **数据通过槽位 props 的 selector 钩子读取，订阅最小的切片。**
5. **样式只用 `--dsw-alias-*` token。** 需要宿主已有的控件外观时，抄它的标记与样式
   并改前缀，而不是 import 它的组件包。
6. **可见文案走 Client 的 locale 服务**，不要硬编码中文字符串。

## 数据流向如何声明

本仓库要求每个插件在自己的 README 里写明数据流向，取值来自 `plugins.json` 的 `dataFlow`：

| 取值               | 含义                           | 要求                                      |
| ------------------ | ------------------------------ | ----------------------------------------- |
| `local-only`       | 不发起任何出网请求             | 默认可接受                                |
| `network-optional` | 默认不出网，用户显式启用后才会 | README 必须写明触发条件与目标地址         |
| `network`          | 功能本身依赖出网               | README 必须写明每次请求发往哪里、携带什么 |

这不只是文档要求：`pnpm verify:manifests` 会校验该字段存在，评审时会对照实现检查。

## 测试策略

分三层，按代价从低到高，覆盖率要求递减：

1. **纯函数测试**（`plugins/<id>/test/*.test.mjs`）：解析、分类、脱敏、状态机。
   这一层必须覆盖主要分支，用 Node 内置 `node:test`，不引第三方测试框架。
2. **契约测试**：清单、patch、导出形态是否符合宿主约定。由 `pnpm verify:manifests`
   统一覆盖，插件不必重复实现。
3. **端到端验证**：真的装进 DSH，真的打开页面看。宿主 API 的细节无法靠 mock 保证，
   这一步不能省。装完要看安装结果的 `application` 字段，并实际使用一次能力。

关于端到端还有一个已知限制：如果当前环境没有浏览器控制能力，视觉验证只能由人确认。
这种情况下必须在交付说明里**明确写出"未经视觉验证"**，而不是含糊地说"应该没问题"。

## 相关文档

- [`../references/dsh-plugin-api.md`](../references/dsh-plugin-api.md)——宿主 API 事实
- [`core-beliefs.md`](core-beliefs.md)——核心理念
- [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)——仓库级依赖方向
