# dsh-plugins 架构地图

本仓库承载 DeepSeek Harness（DSH）的插件。DSH 是"一切皆插件"的 Agent 平台，因此本仓库的
结构要回答的核心问题是：**一个插件由哪些部分组成，它们各自的边界在哪，谁依赖谁。**

## 运行时拓扑

一个 Host + UI 形态的插件在 DSH 中有两个半侧，运行在不同进程里：

```text
                    DSH 宿主进程（Node）
   ┌──────────────────────────────────────────────────────┐
   │  Cordis Loader 按 profile 的 patch 层组装插件行        │
   │                                                      │
   │  plugins/dockyard/index.js   ← Host 半侧             │
   │      export function apply(ctx, config)              │
   │      注册工具 / 监听事件 / 启停本机服务                │
   │      │                                               │
   │      └── 子进程（被托管的开发服务）                    │
   └──────────────────┬───────────────────────────────────┘
                      │ DSH 的 Client 模块图与 Remote 通道
                      ▼
   浏览器页面（Web 客户端）
   ┌──────────────────────────────────────────────────────┐
   │  window.__ModuleLoader__.load({ id, factory })       │
   │  plugins/dockyard/client.js  ← Client 半侧           │
   │      通过 ctx.slots.inject/register 挂到宿主槽位      │
   │      只能用 --dsw-alias-* 主题 token 做样式           │
   └──────────────────────────────────────────────────────┘
```

要点：

- **Host 半侧持有真实资源。** 进程、文件、网络、配置都在 Host。Client 半侧只做呈现与交互。
- **Client 半侧不能 import DSH 内部包。** React 由浏览器模块表提供，其余全部自绘。
- **两半侧通过同一个包名关联。** `package.json` 的 `dsh.client` 与 `./client` 导出让宿主
  知道该包的浏览器产物在哪。
- **安装与组合不归插件管。** 由 DSH 的 `plugin_manager` 写入 profile 的 patch 层。

## 目录布局

```text
dsh-plugins/
├─ AGENTS.md                 智能体导航地图（保持简短）
├─ ARCHITECTURE.md           本文件：目录、依赖方向、包边界
├─ README.md                 面向人的仓库介绍
├─ SECURITY.md               密钥与隐私策略（公开仓库的硬要求）
├─ plugins.json              插件注册表：唯一权威清单，机械检查的依据
├─ plugins/                  具体插件。一个目录一个可安装的 bundle
├─ packages/                 共享库。被插件依赖，自身不是插件
├─ templates/                插件模板。create-plugin 从注册表条目与模板生成骨架
├─ scripts/                  工具与检查脚本（脚手架、校验、生成、扫描）
├─ types/host-stubs/         宿主包的本地类型存根（见文件头说明）
├─ docs/                     知识库：唯一事实源
│  ├─ design-docs/           核心理念、架构决策、ADR
│  ├─ product-specs/         每个插件要做什么与验收标准
│  ├─ exec-plans/            进行中与已完成的工作记录（一等工件）
│  ├─ references/            外部事实卡（DSH API 等）
│  ├─ generated/             脚本产物，禁止手改
│  └─ tech-debt-tracker.md   已知债务
└─ .githooks/                提交前钩子（密钥扫描）
```

## 包边界

每个包只负责它那一列的事，越界要在评审里说明理由。

| 包 / 目录             | 负责内容                                                                 | 不得负责                                            |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `plugins/*`           | 一个可安装的 DSH bundle：Host 半侧、Client 半侧、patch 与清单            | 被其他插件直接 import；共享逻辑要下沉到 `packages/` |
| `packages/plugin-kit` | 写插件用的共享底座：bundle 约定、脱敏、进程与日志工具、槽位与 token 常量 | 任何具体插件的业务语义；依赖任何 DSH 内部包         |
| `scripts/*`           | 脚手架、清单校验、文档校验、代码生成、密钥扫描                           | 承载业务逻辑；脚本之间不互相 import 业务代码        |
| `tests/*`             | 跨包的结构性断言：注册表一致性、依赖方向、边界约束                       | 单包行为测试（那些放在包自己的 `test/`）            |
| `docs/*`              | 唯一事实源：设计、规格、计划、外部事实                                   | 描述"代码现在怎么写"的细节（那是代码注释的事）      |

## 依赖方向

只允许单向依赖，不允许反向，也不允许横向：

```text
docs/  ← 描述一切，被一切描述
  ▲
  │ （人读，不由代码 import）
  │
scripts/  ──读──▶  plugins.json  ◀──校验──  scripts/verify-manifests.mjs
  │
  │ 生成骨架
  ▼
plugins/*  ──依赖──▶  packages/plugin-kit
  │                         │
  │                         └── 只依赖 Node 内置模块
  └── 不允许 import 其他 plugins/*

templates/*  ──被读取──▶  scripts/create-plugin.mjs
```

规则：

1. `packages/plugin-kit` 是最底层，只允许依赖 Node 内置模块。它不得依赖任何插件。
   插件的可安装性要求它与插件之间不能使用工作区协议，因此插件内保留同步副本，
   见 [`docs/design-docs/plugin-architecture.md`](docs/design-docs/plugin-architecture.md)。
2. 插件之间不得互相 import。需要共享时把逻辑下沉到 `packages/`。
3. `plugins.json` 是数据，不是代码。只有 `scripts/` 读它，插件不读它。
4. `templates/` 只被 `scripts/create-plugin.mjs` 读取，不参与任何构建。

## 为什么这么分

这三条取舍直接来自实践经验，不是风格偏好：

- **为什么 Host 与 Client 同包而不是分包。** DSH 用包名把两半侧关联起来：`dsh.client` 与
  `./client` 导出都必须在同一个 `package.json` 上。分包会让宿主找不到浏览器产物。
- **为什么插件用纯 JS 而不是编译 TS。** 插件在 Host 进程内被直接加载，客户端产物是
  由 `window.__ModuleLoader__.load` 注册的惰性工厂。引入打包步骤会让"改完就能装"变成
  "改完还要构建，还要处理构建产物路径"。共享库用 TS 编译是值得的，插件本体不值得。
- **为什么注册表是 JSON 而不是各包自己声明。** 一个中心清单让"有哪些插件、各自什么状态"
  可以被一个脚本一次性校验，也让文档表可以生成而不是手写。分散声明会让一致性无法检查。

## 相关文档

- [`docs/design-docs/plugin-architecture.md`](docs/design-docs/plugin-architecture.md)——插件内部机制
- [`docs/references/dsh-plugin-api.md`](docs/references/dsh-plugin-api.md)——DSH 插件 API 事实
- [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md)——核心理念
