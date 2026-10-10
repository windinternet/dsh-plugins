# 插件模板

这些模板是 `pnpm create-plugin <plugin-id>` 的输入。脚手架读取 `plugins.json` 中该条目的
`kind`，拼装出对应形态的骨架。

| 模板                           | 用于                                  | 产出                                                  |
| ------------------------------ | ------------------------------------- | ----------------------------------------------------- |
| [`host-plugin/`](host-plugin/) | 只有 Host 半侧的插件                  | `index.js` + `cordis.patch.yml` + 基础 `package.json` |
| [`ui-plugin/`](ui-plugin/)     | Host + Client 两半侧                  | 上者再加 `dsh.client`、`./client` 导出与 `client.js`  |
| [`mcp-bundle/`](mcp-bundle/)   | 纯配置型：接一个 MCP server，不写代码 | `package.json` + `cordis.patch.yml`                   |

## 占位符

模板里的 `__PLUGIN_ID__`、`__PACKAGE_NAME__`、`__SUMMARY__`、`__SUMMARY_EN__` 会被脚手架
替换。新增占位符时，必须同步更新 `scripts/create-plugin.mjs`，否则会留一个未替换的
字面量在生成结果里——`pnpm verify:manifests` 不检查这个，评审时要留意。

## 为什么模板用 `.tmpl` 后缀

模板文件本身不是有效的 JS 或 JSON（含有占位符），加 `.tmpl` 后缀可以让 ESLint、Prettier
与 TypeScript 直接忽略它们，避免静态检查在模板上报错。
