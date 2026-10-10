# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的插件集合。

DSH 的核心理念是**一切皆插件**：Agent 的能力、界面、工具、模型接入都由插件组合而成。
这意味着任何需求都可以通过定制插件来满足，而不必等待平台本身的改动。本仓库就是用来
承载这些定制的。

## 仓库里有什么

| 目录                           | 内容                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| [`plugins/`](plugins/)         | 可安装的 DSH 插件。一个目录一个 bundle                                |
| [`packages/`](packages/)       | 写插件用的共享库（[`@dsh-plugins/plugin-kit`](packages/plugin-kit/)） |
| [`templates/`](templates/)     | 插件模板，供脚手架使用                                                |
| [`scripts/`](scripts/)         | 脚手架、清单校验、文档校验、密钥扫描                                  |
| [`docs/`](docs/)               | 知识库：设计、规格、计划、事实卡                                      |
| [`plugins.json`](plugins.json) | 插件注册表（唯一权威清单）                                            |

当前插件清单见 [`docs/generated/plugins.md`](docs/generated/plugins.md)（由脚本生成）。

## 快速开始

```bash
pnpm install
pnpm hooks:install    # 安装提交前密钥扫描钩子，每个克隆执行一次
pnpm check            # 全量检查：格式、lint、类型、清单、文档、密钥、测试
```

创建一个新插件：

```bash
# 1. 先在 plugins.json 登记条目
# 2. 生成骨架
pnpm create-plugin <plugin-id>
```

## 设计与文档

本仓库的文档机制参考 [Harness Engineering](https://openai.com/zh-Hans-CN/index/harness-engineering/)：
`AGENTS.md` 只做**地图**，`docs/` 是唯一事实源，采用渐进式披露，并且结构可机械检查。
文档过期会让检查失败，而不是靠人记得更新。

- 想了解目录与依赖方向：[`ARCHITECTURE.md`](ARCHITECTURE.md)
- 想给智能体当上下文：[`AGENTS.md`](AGENTS.md)
- 想写插件：[`docs/references/dsh-plugin-api.md`](docs/references/dsh-plugin-api.md)
- 安全与密钥策略：[`SECURITY.md`](SECURITY.md)

## 语言约定

仓库内的文档、注释、提交信息使用中文；代码标识符、API 名与专业术语保留英文。
原因是主要协作对象是中文团队，而术语翻译反而会增加理解成本。

## 许可

[MIT](LICENSE)
