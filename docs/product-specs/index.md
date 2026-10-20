# 产品规格索引

每个插件都必须有一份产品规格。规格回答"这个插件要做什么、怎么算做完了"，
而不回答"怎么实现"（那是代码与设计文档的事）。

| 插件        | 规格                               | 状态   |
| ----------- | ---------------------------------- | ------ |
| dockyard    | [`dockyard.md`](dockyard.md)       | 实验性 |
| browser-cdp | [`browser-cdp.md`](browser-cdp.md) | 实验性 |

browser-cdp 的方法论技能正文（同时也是随插件注册进会话技能目录的内容）单独放在
[`browser-cdp-skill.md`](browser-cdp-skill.md)，由
`plugins/browser-cdp/scripts/sync-skill.mjs` 生成模块。

规格与 [`../../plugins.json`](../../plugins.json) 的 `specs` 字段双向绑定：
登记了规格就必须存在，存在规格就必须被登记。
