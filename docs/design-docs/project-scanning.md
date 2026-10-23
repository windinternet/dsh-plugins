# 项目扫描与归一化规则

本文件是 dockyard「扫描」行为的唯一事实源。代码实现见
[`plugins/dockyard/src/project-scanner.js`](../../plugins/dockyard/src/project-scanner.js)，
产品承诺见 [`../product-specs/dockyard.md`](../product-specs/dockyard.md)。

## 要解决的问题

一个开发目录里往往混着很多层东西：一组相关仓库放在同一个文件夹、一个仓库里又有多个语言生态、
Node monorepo 里几十个包。直接把所有 `package.json` / `pom.xml` 平铺成“应用列表”，用户看到的
只是一堆路径，无法回答“这是哪个项目、属于哪个生态、下面有哪些能跑的服务”。

所以扫描结果统一归一化成三层：

```text
项目（git 仓库 / 无 git 但有项目清单的目录）
  └─ 语言生态分组（Java-Maven / Node.js-pnpm / PHP-Composer / ...）
       └─ 可运行应用（命令 + 工作目录 + 判定理由）
```

只有一个语言生态时不渲染分组层——它等价于直接把应用挂在项目下面。

## 项目判定

### 扫描根

1. **扫描根本身是 git 仓库** → 整个扫描根是一个项目；**不展开**子目录。
   项目内部再嵌套的仓库（vendor、示例、子模块）一律忽略。
2. **扫描根本身不是 git，但根上有项目清单**（`pom.xml`、`package.json`、
   `pyproject.toml`、`go.mod`、`Cargo.toml`、`composer.json`、`pubspec.yaml`、
   `Gemfile`、`build.gradle*` 等）→ 扫描根本身是一个项目，`source = manifest`。
3. **否则递归扫描**：进入子目录继续找项目，直到发现 git。

### 递归边界

- **目录自身有 `.git`** → 项目（`source = git`），并且**不再进入这个目录找子项目**。
  项目内部嵌套的仓库（vendor、示例、子模块）一律忽略。
- **目录没有 git** → 继续扫描子目录，直到发现 git 仓库为止。
- 没有 git 的目录如果包含项目，它就是**容器**；项目携带离它最近的
  非 git 祖先作为容器标签（界面上显示为“容器名 · N 个项目”）。
- 没有 git、没有子项目、但根上有项目清单 → 它自己是 `source = manifest` 项目。
- 递归深度上限 6，目录总数上限 4000。

这套规则的含义：

- `tian-gong-one` 本身不是项目；扫描 `Company` 时会穿过它，把 8 个子仓库展开为项目，
  界面显示为“tian-gong-one · 8 个项目”。
- “容器套容器”会继续向下找，直到 git 为止；一旦命中 git 就停。
- 一个目录不会仅仅因为更深处有 `.git` 就变成项目；它只可能是容器。

### 无 git 项目

git 是项目最硬的事实依据，但不是唯一依据：有些目录确实是项目却没有初始化 git。
这类目录只有在**根上有项目清单**时才纳入，并明确标成 `source = manifest`。
既没有 git、也没有清单的目录不会被猜成项目。

## 语言生态与包管理器

每个项目独立检测生态；同一个项目可以有多个生态分组。分组名带包管理器，避免
“都是 Node.js”却不知道用哪个工具启动：

| 生态           | 检测依据                                            | 分组名示例                                                           |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| Java / Maven   | `pom.xml`                                           | `Java (Maven)`                                                       |
| Java / Gradle  | `build.gradle` / `build.gradle.kts` 含 Spring Boot  | `Java (Gradle)`                                                      |
| Node.js        | `package.json` + lockfile / `packageManager`        | `Node.js (pnpm)`、`Node.js (yarn)`、`Node.js (npm)`、`Node.js (bun)` |
| PHP            | `composer.json`                                     | `PHP (Composer)`                                                     |
| Flutter / Dart | `pubspec.yaml`                                      | `Flutter (pub)`                                                      |
| Go             | `go.mod`                                            | `Go (modules)`                                                       |
| Rust           | `Cargo.toml`                                        | `Rust (Cargo)`                                                       |
| Python         | `pyproject.toml` / `requirements.txt` / `manage.py` | `Python (uv)`、`Python (poetry)`、`Python (pip)` 等                  |
| Shell          | `scripts/` 或 `bin/` 下的可执行 `.sh`               | `Shell (scripts)`                                                    |

同一个项目里，不同子包可以使用不同包管理器（例如管理端 `yarn.lock`、PC 端
`pnpm-lock.yaml`），它们会进入不同分组，各自用对应的命令启动。

## 可运行应用判定

只有“能作为长期运行服务启动”的入口才算应用；library、测试、构建脚本不伪装成应用。

### Java / Maven

- 解析根 `pom.xml` 的 `<modules>`；逐个模块解析 `<artifactId>`、`spring-boot-maven-plugin`、
  `<mainClass>`。
- 满足以下之一才算可运行：
  - `spring-boot-maven-plugin` + `<mainClass>`；
  - `spring-boot-maven-plugin` + `src/main/java` 下存在 `@SpringBootApplication`。
- 聚合项目命令：`./mvnw -pl <module> spring-boot:run`（无 wrapper 时用 `mvn`）。
- 单模块 Spring Boot：`mvn spring-boot:run`。
- 普通 library 模块不列入应用，项目诊断里说明原因。

### Node.js

- 工作区声明优先：`package.json` 的 `workspaces`、`pnpm-workspace.yaml`、`lerna.json`。
- 没有工作区时：根包 + 直接子目录里的 `package.json`。
- 有工作区包时不把根包重复列成应用（根脚本通常只是编排）。
- 每个包只取一个启动脚本，优先级 `dev > start > serve > server > run > watch`。
- 包管理器按该包的 `packageManager` 字段或 lockfile 判定；没有时回退到项目根。
- 命令统一为 `<manager> run <script>`，工作目录是该包目录。
- 嵌套的 git 仓库不会被当作当前项目的包。

### PHP / Composer

- `artisan` → `php artisan serve`（Laravel）。
- `bin/console` → `php bin/console server:run`（Symfony）。
- 否则从 `composer.json` 的 `scripts` 里选 `dev/start/serve`。

### Flutter

- `pubspec.yaml` 依赖 `flutter`，或存在 `lib/main.dart` → `flutter run`。
- `flutter run` 可能提示选择设备；这是 Flutter 自身交互，不在插件里猜设备。

### Go

- `go.mod`。
- 根 `main.go` → `go run .`；`cmd/<name>/main.go` → `go run ./cmd/<name>`；
  其他直接子目录的 `main.go` → `go run ./<dir>`。

### Rust

- `Cargo.toml`。
- 单包有 `src/main.rs` 或 `[[bin]]` → `cargo run`。
- workspace 成员有可执行入口 → `cargo run -p <name>`。

### Python

- `manage.py` → `python3 manage.py runserver`（Django）。
- 有依赖声明的 `main.py` / `app.py` / `server.py` → `python3 <file>`。
- 只有依赖声明、没有入口时进诊断，不伪造应用。

## 数据模型

扫描结果：

```text
Project
  id, name, root
  source: 'git' | 'manifest'
  container: { id, name, root } | null
  ecosystems: EcosystemGroup[]
  diagnostics: Diagnostic[]

EcosystemGroup
  id, name, language, manager
  apps: RunnableApp[]

RunnableApp
  id, name, dir, runner, command, args, reason
  projectId, projectName, projectRoot
  ecosystemId, ecosystemName, language, manager
  alreadyAdded
```

应用加入托管后，项目/生态字段随状态一起持久化；服务页按项目分组展示。
`id` 使用 `runner:目录:入口`，重复扫描同一项目不会产生重复记录。

## 周期同步：结构变化以磁盘为准

已托管项目每 5 分钟（`syncIntervalMs`，可关闭）重扫一次，也可以手动触发。同步只读磁盘，
不做自动删除或自动重启：

- **新应用**：加入托管列表，状态为已停止，不自动启动。
- **命令/参数变化**：更新记录，旧值压入 `commandHistory`（最多 10 条）；运行中的应用标记
  `restartRequired`，由用户决定何时重启。
- **应用消失**：标记 `missing`，保留记录、日志、指标历史与旧参数；重新出现时清除标记。
- **项目根目录消失**：项目下应用标记失联，不自动移除。
- **应用 id**：仍由目录 + 生态 + 启动脚本推导；重构导致 id 变化时，旧记录失联、新应用新增，
  不把两者静默合并。

同步是“适应结构”，不是“自动运维”：不自动重启、不自动删除，是刻意的安全边界。

## 托管模型

- **托管的基本单位是项目**：扫描结果按项目展示，勾选项目或点“托管项目”会把项目下
  全部可运行应用一起加入托管；支持全选、托管选中项目、全部托管。
- **操作的最小单位是应用**：项目托管后，启停、重启、移除、查看日志仍逐个应用进行。
- 服务页按项目分组；项目级“移除项目”会把该项目下全部应用移出托管（运行中的应用
  必须先停止）。
- 没有可运行应用的项目不参与托管；界面仍展示它，但只显示诊断。
- 持久化仍以应用记录为准；项目的“已托管”状态由项目下应用推导，不需要额外的项目表。

## 界面行为

- 发现页只有一个「扫描」按钮：点击打开系统文件夹选择框，选中目录后自动扫描。
- 桌面端使用 Electron preload 的 `pick()`；普通 Web 回退到 Host 选择器。
- 两者都没有时，才展开“手动输入路径”作为兜底。
- 结果按 项目 → 生态分组（>1 时才显示）→ 应用 展示；容器里的项目单独成组。
- 没有任何可运行应用的项目仍会列出，但只显示诊断，不占主视觉。
- 服务页按项目分组；应用行带生态标签。

## 已知限制

- git 判定只做 `.git` 存在性检查，不区分分支、子模块或 bare 仓库。
- 递归穿过非 git 目录有深度上限（6 层）与目录总数上限（4000）；极深的容器需要直接扫描内层目录。
- Gradle 只识别根项目的 Spring Boot，不解析多模块 `include`。
- Flutter 的 `flutter run` 设备选择、Maven/npm 的首次依赖安装都交给命令自身。
- 无 git 且无根清单的目录不会被猜成项目。

## 相关文档

- 实现：[`project-scanner.js`](../../plugins/dockyard/src/project-scanner.js)
- 产品规格：[`dockyard.md`](../product-specs/dockyard.md)
- 插件机制：[`plugin-architecture.md`](plugin-architecture.md)
