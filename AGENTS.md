# dsh-plugins 智能体导航

本文件是**地图，不是百科全书**。仓库内已版本化的 `docs/` 目录才是唯一事实源。
你需要知道的任何细节，都不在本文件里，而在本文件指向的地方。

## 这个仓库是什么

DeepSeek Harness（DSH）的插件集合。DSH 的核心理念是"一切皆插件"：Agent 的能力、
界面、工具、模型接入都由插件组合而成。本仓库用于承载我们自研的插件与支撑它们的共享代码。

- 宿主版本基线：`@deepseek-ai/dsh@0.2.0-rc.2`（见 [`docs/references/dsh-plugin-api.md`](docs/references/dsh-plugin-api.md)）。
- 包管理：pnpm workspace + Turborepo。所有包 `private: true`，暂不发布 npm。
- 语言：运行时是纯 JavaScript ESM（DSH 插件不做打包）；共享库可用 TypeScript 并产出 dist。

## 从这里开始

1. 读 [`ARCHITECTURE.md`](ARCHITECTURE.md)，了解目录布局、依赖方向与包边界。
2. 要写插件前，读 [`docs/references/dsh-plugin-api.md`](docs/references/dsh-plugin-api.md)——
   它是从本机 DSH 安装包中提取的插件 API 事实卡，比任何二手教程可靠。
3. 读 [`docs/design-docs/plugin-architecture.md`](docs/design-docs/plugin-architecture.md)，
   了解 bundle、Host 半侧、Client 半侧如何协作。
4. 修改前读 [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md)——核心理念。
5. 要看现在有哪些插件，读 [`docs/generated/plugins.md`](docs/generated/plugins.md)（生成物）。

## 不可违背的约束

这些约束是机械检查或 CI 强制的，不是建议：

- **本仓库是公开仓库。** 禁止提交任何密钥、令牌、个人路径或本机数据。
  密钥只从环境变量读取。详见 [`SECURITY.md`](SECURITY.md)。
- **插件禁止 import 任何 `@deepseek-ai/dsh-client-*` 包。** DSH 明确禁止；
  这些包不是稳定 API，且纯 JS 插件没有类型检查兜底。UI 只能用 `--dsw-alias-*` 主题 token。
- **插件不得默认把用户工作区内容、会话、日志或遥测发到本机之外。** 需要联网的插件
  必须在自己的 README 里写明请求发往哪里、带什么数据。
- **`docs/generated/` 禁止手改。** 它由 `pnpm docs:index` 生成，`pnpm docs:check` 会比对。
- **新增插件必须先登记 [`plugins.json`](plugins.json)。** 它是插件的唯一权威清单，
  `pnpm verify:manifests` 会做双向比对（注册表 ↔ 磁盘）。
- **插件清单必须声明 `engines.dsh`。** 宿主 0.2.1 起按它做兼容性裁决；不声明就只能
  靠运行时碰运气，而失败现象往往是"整个启动挂掉"而不是一条清楚的提示。
- **插件包必须声明 `dsh.bundle.patch`**，UI 插件还要声明 `dsh.client` 与 `./client` 导出。
- **插件不得声明或 import 任何 `@deepseek-ai/*` 宿主包**（含 peer / optional）。
  pnpm 会把它装进 profile 并按包名遮住宿主自带的那份，宿主一升级就触发精确版本校验失败、
  `tools` 行被禁用，全部工具类插件一起失效。需要 `defineTool` 之类能力时用包内实现，
  兼容性用 `engines.dsh` 声明。由 `pnpm verify:plugin-packages` 强制，
  事故复盘见 [`docs/references/dsh-plugin-upgrade-failure.md`](docs/references/dsh-plugin-upgrade-failure.md)。
- **不要手写用户 profile 的 `package.json` 或 `cordis.patch.yml`。** 安装走 DSH 的
  `plugin_manager` 的 `install_bundle`，它会完成装机与组合步骤。

## 必须执行的检查

交付前运行：

```bash
pnpm check
```

它依次执行：格式检查 → ESLint → 类型检查 → 清单校验 → 文档校验 → 密钥扫描 → 测试。
任何一项失败都不要提交。单项也可单独运行，见 [`package.json`](package.json) 的 scripts。

## 文档路由

| 需要了解什么               | 唯一事实源                                                                           | 何时更新               |
| -------------------------- | ------------------------------------------------------------------------------------ | ---------------------- |
| 目录布局、依赖方向、包边界 | [`ARCHITECTURE.md`](ARCHITECTURE.md)                                                 | 新增包或改变边界时     |
| 核心理念与工程取舍         | [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md)               | 原则本身变化时         |
| 插件机制如何运作           | [`docs/design-docs/plugin-architecture.md`](docs/design-docs/plugin-architecture.md) | Host/Client 契约变化时 |
| DSH 插件 API 事实          | [`docs/references/dsh-plugin-api.md`](docs/references/dsh-plugin-api.md)             | 宿主版本升级时         |
| 某个插件要做什么、验收标准 | [`docs/product-specs/`](docs/product-specs/)                                         | 用户可感知的承诺变化时 |
| 正在做的工作               | [`docs/exec-plans/active/`](docs/exec-plans/active/)                                 | 跨多个提交的任务       |
| 已完成的交付记录           | [`docs/exec-plans/completed/`](docs/exec-plans/completed/)                           | 活跃计划完成时         |
| 生成物（禁止手改）         | [`docs/generated/`](docs/generated/)                                                 | 由脚本生成             |
| 已知技术债                 | [`docs/tech-debt-tracker.md`](docs/tech-debt-tracker.md)                             | 明确延后一个问题时     |
| 安全问题与处置流程         | [`SECURITY.md`](SECURITY.md)                                                         | 策略变化时             |

## 常用命令

```bash
pnpm install                 # 安装依赖
pnpm hooks:install           # 安装 git 钩子（每个克隆一次）
pnpm create-plugin <name>    # 由注册表条目生成插件骨架
pnpm docs:index              # 重新生成插件清单
pnpm check                   # 交付前必跑
```

## 本仓库刻意不做的事

写在这里，避免后来者反复重新讨论：

- **不做发布流水线。** 所有包 private，插件通过本地路径安装。等某个插件真正成熟再单独讨论。
- **不为单个功能开分支。** 直接在 `main` 上工作；PR 生命周期越短越好。
- **不引入组件库到插件 UI。** Semi Design、Ant Design 之类会与宿主主题冲突，见约束一节。
- **不维护第二套文档机制。** 文档结构对齐 Harness Engineering：短地图 + 分层事实源 + 机械检查。
