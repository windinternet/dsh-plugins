# 文档事实源

本仓库的文档机制采用 [Harness Engineering](https://openai.com/zh-Hans-CN/index/harness-engineering/)
的思路：给智能体一张**地图**而不是一本手册，把知识库版本化，采用渐进式披露，
并且让结构可被机械检查。

| 需要了解什么                | 唯一事实源                                                                             | 何时更新                |
| --------------------------- | -------------------------------------------------------------------------------------- | ----------------------- |
| 仓库目录、依赖方向、包边界  | [`../ARCHITECTURE.md`](../ARCHITECTURE.md)                                             | 新增包或改变边界时      |
| 核心理念与工程取舍          | [`design-docs/core-beliefs.md`](design-docs/core-beliefs.md)                           | 原则本身变化时          |
| 插件机制如何运作            | [`design-docs/plugin-architecture.md`](design-docs/plugin-architecture.md)             | Host/Client 契约变化时  |
| DSH 插件 API 事实           | [`references/dsh-plugin-api.md`](references/dsh-plugin-api.md)                         | 宿主版本升级时          |
| 工具定义 / JSON Schema 契约 | [`references/dsh-plugin-tools.md`](references/dsh-plugin-tools.md)                     | `defineTool` 契约变化时 |
| 宿主升级导致启动失败        | [`references/dsh-plugin-upgrade-failure.md`](references/dsh-plugin-upgrade-failure.md) | 再次发生同类事故时      |
| 插件要做什么、验收标准      | [`product-specs/`](product-specs/)                                                     | 用户可感知的承诺变化时  |
| 正在进行的工作              | [`exec-plans/active/`](exec-plans/active/)                                             | 任务跨越多个提交时      |
| 已完成的交付记录            | [`exec-plans/completed/`](exec-plans/completed/)                                       | 活跃计划完成时          |
| 生成物（禁止手改）          | [`generated/`](generated/)                                                             | 由脚本生成              |
| 已知债务                    | [`tech-debt-tracker.md`](tech-debt-tracker.md)                                         | 明确延后一个问题时      |

## 为什么这样分层

一份巨大的 `AGENTS.md` 会挤掉任务、代码与真正相关的文档，让智能体在错误的约束上做优化；
而且它会立刻腐烂，没人能判断其中哪条还有效。所以这里的规则是：

- **地图要短。** `AGENTS.md` 只回答"去读哪个文件"，不复制内容。
- **每件事只有一个事实源。** 同一件事写在两处，就一定会有一处是错的。
- **生成物不手写。** `generated/` 由脚本产生，`pnpm docs:check` 比对，过期即失败。
- **检查代替记忆。** 文档的完整性与链接可达性由 `pnpm docs:check` 强制，不靠自觉。

## 机械检查覆盖了什么

`pnpm docs:check` 会检查：

1. 必需入口文档存在（地图与事实源骨架未被破坏）。
2. 所有 Markdown 的相对链接都能解析到真实文件。
3. 每个 Markdown 文件有标题或 front matter，不出现无标题碎片。
4. 每个插件都有 `README.md` 与 `product-specs` 规格文档。
5. `docs/generated/` 与生成器输出一致。
6. 文档中不含疑似真实密钥。

它**不**检查内容是否正确——那是评审与测试的职责。检查的边界写在这里，是为了避免
把"检查通过"误当成"文档写对了"。
