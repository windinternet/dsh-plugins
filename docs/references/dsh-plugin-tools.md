# DSH 工具 API 事实卡

本文件记录**写一个注册工具的插件**所需的最小事实集。所有条目都是从本机安装包的
构建产物里读出来的（JSDoc 在构建后仍然保留），不是二手转述，也不是推断。

| 项       | 值                                                                     |
| -------- | ---------------------------------------------------------------------- |
| 提取时间 | 2026-10-16                                                             |
| 宿主包   | `@deepseek-ai/dsh-tools@0.2.0-rc.2`、`@deepseek-ai/schemastery@3.18.4` |
| 来源     | `app.asar` 内 `/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`  |
| 升级后   | 需要重新核对；核对方法见文末                                           |

## `defineTool` 的契约

必填字段：`name`、`description`、`parameters`、`output.schema`、**`output.render`**、`execute`。
缺 `output.render` 会在**注册时**直接抛 `TypeError`（`tool "X" must declare output { schema, render, presentationMeta? }`），
不是等到调用才炸。

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

ctx.tools.register(
  defineTool({
    name: 'example',
    description: '一句话说明这个工具做什么、什么时候该用。',
    parameters: {
      // 每个键一个 value-schema 规格；属性级专有键是 required
      query: { type: 'string', required: true, description: '查询内容。' },
      limit: { type: 'number', description: '上限。' },
      mode: { type: 'string', enum: ['fast', 'full'], description: '模式。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.answer }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return { answer: '…', count: 1 };
    },
  }),
);
```

### `execute(args, exec)` 返回什么

**只返回声明的 JSON 值**，它会被严格按 `output.schema` 校验，然后才交给 `output.render`。
返回内部结构（例如带嵌套对象的报告）而不做投影，会以"输出校验失败"的形式炸掉——
那种错误对使用者毫无信息量，所以投影必须在 `execute` 里完成。

`exec` 至少含：`{ signal, agent?, callId, rootCallId, name, token }`。
`agent` 在非会话场景下可能是 `undefined`（例如被其它组件直接执行），读之前要判空。

### `parameters` 支持的写法

- 类型：`string` / `number` / `integer` / `boolean` / `null` / `array` / `object` / `json` / `oneOf`。
- 注解键：`description`、`title`、`default`、`examples`。
- **属性级专有键：`required`**（默认全部可选）。
- `object` 必须显式声明 `additionalProperties`（布尔）。
- 数组用 `items` 描述元素。
- 不支持的形状会在 `defineTool` 调用时立刻抛错（author error），不会拖到运行期。

### 展示内容块

`output.render(args, value)` 返回内容块数组。当前宿主自带的工具全部只产出
`{ type: 'text', text }`；**没有图片块**。这也是截图类能力必须"落盘 + 返回路径"的原因：
把 base64 塞进文本块既会让上下文爆炸，也不被任何渲染路径当作图片处理。

### 其它可选字段

| 字段                                 | 作用                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `timeoutMs`                          | 声明式超时。**注册表不强制**，是给超时策略插件读的元数据。 |
| `isConcurrencySafe(args)`            | 声明该调用能否与其他调用并发。                             |
| `deferLoading`                       | 让工具定义延迟装载（用于超大工具目录）。                   |
| `finalizeContent` / `projectContent` | 结果的最终化与投影钩子，MCP 类插件在用。                   |
| `presentCall` / `presentResult`      | 宿主侧展示意图；自带 Web Client 不消费。                   |

**没有** `readOnly` / `dangerous` 这类元数据字段。

## `ctx.tools`（ToolRuntime）

| 方法                             | 说明                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `register(definition)`           | 注册工具，**返回精确的注销函数**。                        |
| `restrict(filter)`               | 只做减法（allow/deny 掩码），只能在 scoped ctx 上用。     |
| `guard(guard)`                   | 单调守卫，返回字符串即拒绝；在 `tools/pre-execute` 之后。 |
| `get(name, scope)`               | 取某个 scope 解析到的定义。                               |
| `view(scope)` / `schemas(scope)` | 派生视图 / 深拷贝的 schema 列表。                         |
| `execute(exec)`                  | 执行一次调用并拿到最终结果。                              |

事件：`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`、`tools/change`。

## Config（schemastery 3.18.4）

默认导入：`import z from '@deepseek-ai/schemastery';`

- **裸写 `z.string()` 是可选字段**；`.required()` 才是必填；`.default(v)` 给默认值。
- 常用形态：`z.object({ a: z.string().default('x'), b: z.array(z.string()).default([]) })`。
- 官方插件里的真实例子（`dsh-skill-filesystem`）：

  ```js
  const Config = z.object({
    providerName: z.string().min(1).default('filesystem'),
    includeDefaultRoots: z.boolean().default(true),
    customSkillDirs: z.array(z.string()).default([]),
    watch: z.boolean().default(true),
  });
  ```

- `export const Config` 之后，用户在 profile 的 `cordis.patch.yml` 里覆盖该行的 `config`，
  那份 patch 层能挺过插件升级——所以**可调参数都应该放进 Config**。

## inject 的语义（容易搞错）

`inject` 数组里的**每一项都是硬需求**。缺少任一项时插件**不激活**（INACTIVE），
不报错、不打日志——现象是"装好了但什么都没发生"。

- 需要某服务：`export const inject = ['tools'];`
- 可选服务：`ctx.get('webServer', false)`（不存在时得到 `undefined`），
  或 `ctx.inject(['webServer'], (ctx) => { … })` 建一个服务可用时才运行的子 fiber。
- `logger` 是 cordis 内建服务，**从来不需要 inject**。

## 重新核对本文件的步骤

```bash
APP="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
# asar 头是 pickle：数据区偏移 = 16 + headerSize + 2
# 1) 读 /dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js，搜 "function defineTool"
# 2) 读 lib/types/index.js，搜 "must declare output" 与 "output.${projector}"
# 3) 读任一官方工具（例如 dsh-tool-web/lib/index.js）作为形态参考
# 4) 读 dsh-skill-filesystem/lib/index.js 核对 Config 写法
```
