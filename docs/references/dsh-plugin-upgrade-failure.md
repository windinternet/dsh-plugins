# 升级事故复盘：插件把宿主包装进 profile，宿主升级后启动失败

本文件记录一次真实事故的**根因链与修复**，供后来者与智能体直接复用。
症状看起来像"DeepSeek Harness 更新后坏了"，实际是插件依赖声明方式的问题。

| 项       | 值                                                                   |
| -------- | -------------------------------------------------------------------- |
| 发生时间 | 2026-10-20                                                           |
| 触发动作 | DeepSeek Harness Desktop 从 `0.2.0-rc.2` 升级到 `0.2.1-rc.2`         |
| 症状     | 桌面端启动失败，日志只有一句话：`1 required plugin did not activate` |
| 影响面   | 全部依赖 `tools` 服务的插件（工具类插件几乎全中）                    |

## 症状原文

```text
dsh: disabling profile plugin row "tools": Plugin @deepseek-ai/dsh-tools@0.2.0-rc.2
is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-agent":"0.2.0-rc.2", ...}
Running it may cause crashes or data loss. ...
dsh: startup failed: 1 required plugin did not activate

Plugins waiting for services (9):
  agent-loop (required)      tools
  ...
  browser-cdp                tools
```

## 根因链（三个条件缺一不可）

1. **插件把宿主内部包写成了普通依赖。**
   `@dsh-plugins/browser-cdp` 的 `package.json` 里有
   `"dependencies": { "@deepseek-ai/dsh-tools": "0.2.0-rc.2", "@deepseek-ai/schemastery": "3.18.4" }`。
   本意是"外部插件无法凭空解析宿主内部包，所以真装一份"——这个判断在 0.2.0 上成立，
   但它埋下了一个更危险的问题（见第 2 条）。

2. **pnpm 把这份副本装进了 profile，按包名解析时会遮住宿主自带的包。**
   安装后的目录是 `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-tools`。
   宿主配置树里的行是按**裸包名**解析的（`name: '@deepseek-ai/dsh-tools'`），
   Node 的解析链从 profile 出发，先命中的就是这份 0.2.0-rc.2 的副本。

3. **宿主 0.2.1 起做精确版本校验，不匹配就 fail-loud。**
   `@deepseek-ai/dsh-app-boot` 读取被加载包的 `package.json`，
   用它的 `peerDependencies`（或 `engines.dsh`）与运行时版本比对：

   ```js
   // dsh-app-boot/lib/index.js（0.2.1-rc.2，节选）
   function unmetRequirements(fields, runtimeVersion) {
     const engines = ...;
     if (Object.hasOwn(engines, 'dsh')) { /* engines.dsh 单独裁决 */ }
     for (const [name, range] of Object.entries(fields.peerDependencies ?? {})) {
       if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
       if (!satisfies(runtimeVersion, range)) unmet[name] = range;
     }
   }
   ```

   0.2.0-rc.2 的 `dsh-tools` 把 `dsh-agent`、`dsh-llm` 等十个宿主包都钉在 `0.2.0-rc.2`，
   于是整行被禁用（而不是降级加载）。`tools` 是所有工具类插件共同的依赖，禁一行等于整条链断电。

4. **附带因素：恢复按钮只重置 `bundles`，不清 `node_modules`。**
   所以"点一下恢复"之后插件行没了，但 profile 里那份旧副本还在，问题会反复出现。

## 为什么"对齐版本"不是解法

把依赖改成 `0.2.1-rc.2` 只是把炸弹的引信延长到下一次升级：
宿主再升级、或用户装了另一个钉死旧版本的插件，同样会遮住宿主。
只要 profile 里存在第二份宿主自带包，就迟早会触发这个失败模式。

## 正确做法（本仓库的现行规则）

1. **插件不得声明任何 `@deepseek-ai/*` 依赖**——`dependencies`、`peerDependencies`、
   `optionalDependencies` 全都不行（peer 会被 pnpm 自动安装，同样落进 profile）。
2. 需要 `defineTool` 这类宿主动能时，用包内实现（`src/internal/` 下的同步副本），
   只产出宿主接受的 JSON Schema 子集。
3. 需要宿主服务（工具注册表、技能注册表、HTTP 路由）时用 `ctx.inject` / `ctx.get`，
   这些是运行期传入的对象，不会引入任何包。
4. 兼容性用 `engines.dsh` 声明（例如 `"^0.2.0-rc.2"`）。宿主会据此**在启动前**给出
   明确的不兼容提示，而不是让启动挂在半路。
5. 这些规则由 `scripts/verify-plugin-packages.mjs` 机械检查，纳入 `pnpm check`。

## 事故后的现场处理

```bash
# 1) 从 profile 的 bundles 里移除插件（或按官方恢复流程重置 bundles）
# 2) 删掉被污染的第二份宿主包（重新安装会自动清理，手工清理也可以）
rm -rf ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai

# 3) 升级到修复后的插件版本，再装回去
dsh plugin --profile desktop add "file:/path/to/dsh-plugins/plugins/browser-cdp"
```

安装后确认 profile 的 `node_modules/@deepseek-ai/` **为空或不存在**——一旦有东西，就说明
还有插件在声明宿主包依赖。

## 给平台侧的建议（不属于本仓库能改的范围）

- 宿主解析自己的内置行时，不应被 profile 里的同名包劫持；或至少给出比
  `1 required plugin did not activate` 更直接的指向性诊断（当前日志已经把原因写清，
  但只在 `disabling profile plugin row` 那一行里，容易被忽略）。
- 外部插件需要宿主内部包时，应有一个"由宿主提供"的受支持通道（例如由宿主注入
  `defineTool`/`Schema` 工厂），而不是让插件往 profile 里装第二份副本。
