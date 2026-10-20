# 执行计划：让插件跨宿主升级不再炸（依赖边界修复）

## 目标

修复 2026-10-20 的启动事故：DeepSeek Harness Desktop 从 `0.2.0-rc.2` 升到 `0.2.1-rc.2` 后，
`tools` 行被禁用、9 个插件在等它、整个启动失败。

判定完成（可机械核对）：

1. 复现事故并记录真实报错（不是转述）。
2. 插件与共享实现**不再 import 任何 `@deepseek-ai/*` 宿主包**，也不把它们写进任何依赖组。
3. 新宿主（0.2.1-rc.2）的干净 profile 里安装后能正常激活，且 profile 的
   `node_modules/@deepseek-ai/` 为空。
4. `pnpm check` 全绿，并新增一条**机械检查**防止回归。
5. 事故复盘、API 事实卡、两个插件的 README、AGENTS 约束同步更新。

## 根因（实测）

| 条件     | 事实                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发条件 | 插件把 `@deepseek-ai/dsh-tools@0.2.0-rc.2` 与 `@deepseek-ai/schemastery` 声明成 `dependencies`                                                                   |
| 中间条件 | pnpm 把它们装进 `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/`；宿主按**裸包名**解析配置行，profile 里的同名包抢先命中                                     |
| 致命条件 | 宿主 0.2.1 起在 `dsh-app-boot` 里做版本裁决：报 `Plugin @deepseek-ai/dsh-tools@0.2.0-rc.2 is incompatible with dsh 0.2.1-rc.2`，直接禁用 `tools` 行（fail-loud） |
| 放大因素 | 恢复流程只重置 `bundles`，不清 `node_modules`，所以问题会反复出现                                                                                                |

## 采取的修复

1. **零宿主依赖。** 新增 `packages/plugin-kit/src/tool-definition.js`（等价 `defineTool`：
   作者写法 → 宿主接受的 JSON Schema 子集，并自己做参数校验）与
   `src/config.js`（规格表归一化，替代 schemastery `Config`）。
   插件内放 `src/internal/` 同步副本，两个插件都改用它。
2. **两个插件都去掉 `dependencies`，改声明 `engines.dsh: "^0.2.0-rc.2"`。**
   以后宿主大版本变化时，宿主的版本裁决会给出明确提示，而不是运行时炸。
3. **配置改为"回退默认值 + 诊断"**，非法配置不再可能阻止插件激活；
   代价是宿主的插件设置页不渲染字段表单（记为 TD-004）。
4. **新增 `scripts/verify-plugin-packages.mjs`** 并接入 `pnpm check`：
   - 禁止 `@deepseek-ai/*` 出现在任何依赖组；
   - 禁止插件代码 import 宿主包（先剥注释、再遮字符串，避免误判）；
   - 要求每个插件声明 `engines.dsh`；
   - 非宿主依赖必须登记到注册表的 `runtimeDependencies`（可见性）。
5. **新增 `tests/` 仓库级测试**：验证检查脚本能抓住真实坏清单、不误判注释/字符串。
6. **文档同步**：事故复盘、API 事实卡改掉错误建议、AGENTS 约束、两个 README。

## 进度

- [x] 复现并记录真实报错（临时 profile，宿主 0.2.1-rc.2）
- [x] 零宿主依赖实现 + 两个插件改造
- [x] 机械检查 + 仓库级测试 + 接入 `pnpm check`
- [x] 文档同步（含把旧版"必须真装宿主包"的错误建议改正）
- [ ] 新宿主干净 profile 安装验证
- [ ] 修复用户实际 profile 并装回插件（需重启桌面端生效）

## 遗留

- 宿主的版本裁决是"禁用整行"，日志里原因很清楚，但最终错误只有
  `1 required plugin did not activate`；希望平台能把原因前置到最终错误里。
- 插件设置页的字段表单暂时没有（TD-004），等宿主提供"注入 schema 工厂"的受支持通道。
- 同类风险仍存在于任何**第三方**插件：只要它声明宿主包依赖，就会污染 profile。
  本仓库只能保证自己的插件干净；`verify:plugin-packages` 的错误信息会直接给出修复指令。
