<!-- 由 scripts/gen-docs-index.mjs 生成，请勿手动编辑。 -->
<!-- 修改内容请改 plugins.json，然后运行 pnpm docs:index。 -->

# 插件清单

本表由 `plugins.json` 生成，是"仓库里有哪些插件"的唯一权威视图。新增插件时先登记 `plugins.json`，再用 `pnpm create-plugin` 生成骨架。

## 插件

| 插件 | 包名 | 形态 | 状态 | 数据流向 | 目录 | 规格 |
| --- | --- | --- | --- | --- | --- | --- |
| dockyard | `@dsh-plugins/dockyard` | Host 插件 + UI 插件 | 实验性 | 仅本机 | `plugins/dockyard` | [规格](../product-specs/dockyard.md) |
| browser-cdp | `@dsh-plugins/browser-cdp` | Host 插件 + UI 插件 | 实验性 | 仅本机 | `plugins/browser-cdp` | [规格](../product-specs/browser-cdp.md) |

## 共享包

| 包 | 包名 | 目录 | 说明 |
| --- | --- | --- | --- |
| plugin-kit | `@dsh-plugins/plugin-kit` | `packages/plugin-kit` | 写 DSH 插件需要的共享底座：bundle 约定、脱敏、进程与日志工具、槽位与主题 token 常量。 |

## 插件摘要

### dockyard

本机开发服务的可观测托管台：扫描项目、受监管地启停应用、tail 日志，并在 DSH 侧栏提供运行面板。

### browser-cdp

让智能体用 CDP 直接驱动一个受管 Chromium：自适应端口、独立 profile、结构化页面操作与截图，并随插件提供方法论技能。

---

生成命令：`pnpm docs:index`
