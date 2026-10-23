/**
 * 项目扫描：把用户选中的目录归一化成 **项目 → 生态分组 → 可运行应用**。
 *
 * 核心规则（与 docs/design-docs/project-scanning.md 保持一致）：
 *
 * 1. 扫描根自身是 git 仓库 → 整个根是一个项目，不展开子目录。
 * 2. 否则只看扫描根的直接子目录：
 *    - 有 `.git` → 项目；
 *    - 没有 git、但根上有项目清单（pom.xml / package.json / ...）→ 无 git 项目；
 *    - 两项都没有、但直接子目录里有 git 仓库或项目清单 → 把它当作**容器**，
 *      只展开这一层，子目录成为项目并带上容器信息；不再往更深处递归。
 * 3. 子目录里的 `.git` 永远不单独成为项目：项目内部再嵌套仓库（vendor、示例）一律忽略。
 *
 * 之所以这么定：git 是“这是一个独立项目”最硬的事实依据；容器只是把一组仓库放在一起的
 * 普通文件夹，它本身不是项目，但它的直接子仓库应该被看见。
 *
 * 所有读到的文件内容都当作不可信输入：形状不对就记诊断，而不是带着脏数据往下走。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { isIgnoredDir, selectRunScripts } from './internal/app-scanner.js';

/** 扫描时最多检查的目录数，防止误选大盘根目录。 */
const MAX_DIRS = 4000;
/** 一个工作区 glob 最多展开出的目录数。 */
const MAX_GLOB_DIRS = 200;
/** 项目递归发现的最大深度（只穿过非 git 目录）。 */
const MAX_PROJECT_DEPTH = 6;
/** 一次扫描最多产出的项目数，防止误选大盘根目录。 */
const MAX_PROJECTS = 500;
/** 递归查找 Java 注解时最多读的源文件数。 */
const MAX_JAVA_FILES = 400;

/** 项目清单文件。出现在目录根部时，即便没有 git 也当作项目。 */
const PROJECT_MANIFEST_FILES = new Set([
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'pubspec.yaml',
  'Gemfile',
]);

/** Node script 的优先级：越靠前越像“启动开发服务”。 */
const NODE_SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'server', 'run', 'watch'];

/**
 * @typedef {object} ScanDiagnostic
 * @property {string} path
 * @property {string} message
 */

/**
 * @typedef {'node'|'python'|'shell'|'maven'|'gradle'|'php'|'flutter'|'dart'|'go'|'rust'|'dotnet'|'ruby'} AppRunner
 */

/**
 * @typedef {object} RunnableApp
 * @property {string} id
 * @property {string} name
 * @property {string} dir
 * @property {AppRunner} runner
 * @property {string} command
 * @property {string[]} args
 * @property {string} reason
 * @property {string} [scriptName]
 * @property {boolean} [alreadyAdded]
 * @property {string} [projectId]
 * @property {string} [projectName]
 * @property {string} [projectRoot]
 * @property {string} [ecosystemId]
 * @property {string} [ecosystemName]
 * @property {string} [language]
 * @property {string} [manager]
 */

/**
 * @typedef {object} EcosystemGroup
 * @property {string} id
 * @property {string} name 展示名，例如 “Java (Maven)”
 * @property {string} language
 * @property {string} manager
 * @property {RunnableApp[]} apps
 */

/**
 * @typedef {object} ContainerInfo
 * @property {string} id
 * @property {string} name
 * @property {string} root
 */

/**
 * @typedef {object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} root
 * @property {'git'|'manifest'} source
 * @property {ContainerInfo | null} container
 * @property {EcosystemGroup[]} ecosystems
 * @property {ScanDiagnostic[]} diagnostics
 */

/**
 * @typedef {object} ScanState
 * @property {number} scannedDirs
 * @property {ScanDiagnostic[]} diagnostics
 */

/**
 * @typedef {object} ProjectScanResult
 * @property {Project[]} projects
 * @property {ScanDiagnostic[]} diagnostics
 * @property {number} scannedDirs
 */

/**
 * 判断目录是否是 git 仓库。`.git` 是目录或 worktree 文件都算。
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function isGitRepo(dir) {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function isExecutable(path) {
  try {
    return ((await stat(path)).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * 读取目录下的子目录名，跳过隐藏目录、node_modules、构建产物等。
 * @param {string} dir
 * @param {ScanState} state
 * @returns {Promise<string[]>}
 */
async function readChildDirs(dir, state) {
  if (state.scannedDirs >= MAX_DIRS) return [];
  state.scannedDirs += 1;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !isIgnoredDir(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    state.diagnostics.push({
      path: dir,
      message: `无法读取目录：${error instanceof Error ? error.message : String(error)}`,
    });
    return [];
  }
}

/**
 * 读取目录下的文件名。
 * @param {string} dir
 * @param {ScanState} state
 * @returns {Promise<Set<string>>}
 */
async function readFileNames(dir, state) {
  if (state.scannedDirs >= MAX_DIRS) return new Set();
  state.scannedDirs += 1;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

/**
 * 目录根部是否有项目清单。`*.csproj` / `*.sln` 也算。
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function hasProjectManifest(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (PROJECT_MANIFEST_FILES.has(entry.name)) return true;
    if (entry.name.endsWith('.csproj') || entry.name.endsWith('.sln')) return true;
  }
  return false;
}

/**
 * 读一个 JSON 对象；失败时记诊断并返回 null。
 * @param {string} file
 * @param {Project} project
 * @returns {Promise<Record<string, any> | null>}
 */
async function readJsonObject(file, project) {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      project.diagnostics.push({ path: file, message: '顶层不是对象，已跳过。' });
      return null;
    }
    return parsed;
  } catch (error) {
    project.diagnostics.push({
      path: file,
      message: `读取或解析失败：${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

/**
 * @param {Project} project
 * @param {string} id
 * @param {string} name
 * @param {string} language
 * @param {string} manager
 * @returns {EcosystemGroup}
 */
function addGroup(project, id, name, language, manager) {
  const existing = project.ecosystems.find((group) => group.id === id);
  if (existing) return existing;
  const group = { id, name, language, manager, apps: [] };
  project.ecosystems.push(group);
  return group;
}

/**
 * @param {EcosystemGroup} group
 * @param {Project} project
 * @param {RunnableApp} app
 */
function addApp(group, project, app) {
  group.apps.push({
    ...app,
    projectId: project.id,
    projectName: project.name,
    projectRoot: project.root,
    ecosystemId: group.id,
    ecosystemName: group.name,
    language: group.language,
    manager: group.manager,
  });
}

/**
 * 从候选脚本里挑一个作为应用的启动脚本。
 * @param {{name: string, reason: string}[]} picked
 * @returns {{name: string, reason: string}}
 */
function pickPrimaryScript(picked) {
  /** @param {string} name */
  const score = (name) => {
    const index = NODE_SCRIPT_PRIORITY.indexOf(name);
    return index === -1 ? 99 : index;
  };
  const primary = [...picked].sort((a, b) => score(a.name) - score(b.name))[0];
  if (!primary) throw new Error('pickPrimaryScript 需要至少一个候选');
  return primary;
}

/**
 * 读取 Node 工作区声明：package.json workspaces、pnpm-workspace.yaml、lerna.json。
 * @param {string} root
 * @param {Record<string, any> | null} pkg
 * @param {Project} project
 * @returns {Promise<string[]>}
 */
async function readWorkspaceGlobs(root, pkg, project) {
  /** @type {string[]} */
  const globs = [];
  const workspaces = pkg?.workspaces;
  if (Array.isArray(workspaces)) {
    globs.push(...workspaces.filter((item) => typeof item === 'string'));
  } else if (workspaces && typeof workspaces === 'object' && Array.isArray(workspaces.packages)) {
    globs.push(
      ...workspaces.packages.filter((/** @type {unknown} */ item) => typeof item === 'string'),
    );
  }

  const pnpmFile = join(root, 'pnpm-workspace.yaml');
  if (await isFile(pnpmFile)) {
    try {
      const text = await readFile(pnpmFile, 'utf8');
      let inPackages = false;
      for (const line of text.split('\n')) {
        if (/^\s*packages\s*:/.test(line)) {
          inPackages = true;
          continue;
        }
        if (!inPackages) continue;
        if (/^\S/.test(line) && !line.trim().startsWith('-')) break;
        const match = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/);
        if (match && match[1]) globs.push(match[1]);
      }
    } catch (error) {
      project.diagnostics.push({
        path: pnpmFile,
        message: `读取 pnpm-workspace.yaml 失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const lernaFile = join(root, 'lerna.json');
  if (await isFile(lernaFile)) {
    const lerna = await readJsonObject(lernaFile, project);
    if (Array.isArray(lerna?.packages)) {
      globs.push(
        ...lerna.packages.filter((/** @type {unknown} */ item) => typeof item === 'string'),
      );
    }
  }
  return [...new Set(globs)];
}

/**
 * 判断某个 Node 包用的包管理器。packageManager 字段优先，其次看该目录的 lockfile；
 * 都没有时退回项目根的 manager（工作区包通常没有自己的 lockfile）。
 * @param {string} root
 * @param {Record<string, any> | null} pkg
 * @param {'pnpm'|'yarn'|'bun'|'npm'} [fallback]
 * @returns {Promise<'pnpm'|'yarn'|'bun'|'npm'>}
 */
async function detectNodeManager(root, pkg, fallback = 'npm') {
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager : '';
  for (const manager of ['pnpm', 'yarn', 'bun', 'npm']) {
    if (declared.startsWith(manager)) return /** @type {any} */ (manager);
  }
  if (await isFile(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await isFile(join(root, 'yarn.lock'))) return 'yarn';
  if ((await isFile(join(root, 'bun.lockb'))) || (await isFile(join(root, 'bun.lock'))))
    return 'bun';
  if (await isFile(join(root, 'package-lock.json'))) return 'npm';
  return fallback;
}

/**
 * 把 glob 段（只支持 * 与 **）转成正则。
 * @param {string} segment
 * @returns {RegExp}
 */
function globSegmentRegex(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 展开一个简单工作区 glob。只支持 * 与 **，最多展开 MAX_GLOB_DIRS 个目录。
 * @param {string} root
 * @param {string} pattern
 * @param {ScanState} state
 * @returns {Promise<string[]>}
 */
async function expandGlob(root, pattern, state) {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '' || normalized.startsWith('/') || normalized.includes('..')) return [];

  /** @type {string[]} */
  let current = [root];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    /** @type {string[]} */
    const next = [];
    for (const dir of current) {
      if (segment === '**') {
        next.push(dir);
        /** @type {{dir: string, depth: number}[]} */
        const stack = [{ dir, depth: 0 }];
        while (stack.length > 0 && next.length < MAX_GLOB_DIRS) {
          const item = stack.pop();
          if (!item || item.depth >= 3) continue;
          for (const child of await readChildDirs(item.dir, state)) {
            const childPath = join(item.dir, child);
            next.push(childPath);
            stack.push({ dir: childPath, depth: item.depth + 1 });
          }
        }
      } else if (segment.includes('*')) {
        const regex = globSegmentRegex(segment);
        for (const child of await readChildDirs(dir, state)) {
          if (regex.test(child)) next.push(join(dir, child));
        }
      } else {
        const candidate = join(dir, segment);
        if (await isDirectory(candidate)) next.push(candidate);
      }
    }
    current = [...new Set(next)].slice(0, MAX_GLOB_DIRS);
  }
  return current.filter((dir) => dir !== root);
}

/**
 * Node.js：根 package.json + 工作区包（或第一层子包）。
 * @param {Project} project
 * @param {ScanState} state
 */
async function detectNode(project, state) {
  const root = project.root;
  const rootPkg = (await isFile(join(root, 'package.json')))
    ? await readJsonObject(join(root, 'package.json'), project)
    : null;

  const workspaceGlobs = await readWorkspaceGlobs(root, rootPkg, project);
  const rootManager = await detectNodeManager(root, rootPkg);

  /** @type {Set<string>} */
  const packageDirs = new Set();
  if (rootPkg) packageDirs.add(root);

  if (workspaceGlobs.length > 0) {
    for (const glob of workspaceGlobs) {
      for (const dir of await expandGlob(root, glob, state)) {
        // 项目内部再嵌套的 git 仓库属于独立项目，不能混进当前项目的应用列表。
        if ((await isGitRepo(dir)) && dir !== root) continue;
        if (await isFile(join(dir, 'package.json'))) packageDirs.add(dir);
      }
    }
  } else {
    for (const child of await readChildDirs(root, state)) {
      const childPath = join(root, child);
      if (await isGitRepo(childPath)) continue;
      if (await isFile(join(childPath, 'package.json'))) packageDirs.add(childPath);
    }
  }

  /** @type {{ dir: string, pkg: Record<string, any>, script: { name: string, reason: string } }[]} */
  const candidates = [];
  let sawPackage = false;
  for (const dir of packageDirs) {
    const pkg = dir === root ? rootPkg : await readJsonObject(join(dir, 'package.json'), project);
    if (!pkg) continue;
    sawPackage = true;
    const scripts =
      pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
        ? pkg.scripts
        : {};
    const picked = selectRunScripts(scripts).filter((item) => {
      const command = typeof scripts[item.name] === 'string' ? scripts[item.name] : '';
      // tsup/tsc/rollup 的 --watch 是构建监听，不是可托管的服务。
      if (/(?:^|\s)(?:tsup|tsc|rollup|esbuild)\b.*--watch/i.test(command)) return false;
      if (/\bvite\s+build\b/i.test(command)) return false;
      return true;
    });
    if (picked.length === 0) continue;
    candidates.push({ dir, pkg, script: pickPrimaryScript(picked) });
  }

  const workspaceApps = candidates.filter((candidate) => candidate.dir !== root);
  const final = workspaceGlobs.length > 0 && workspaceApps.length > 0 ? workspaceApps : candidates;

  if (final.length === 0) {
    if (sawPackage) {
      project.diagnostics.push({
        path: join(root, 'package.json'),
        message: 'Node.js 包未发现 dev/start/serve 脚本，没有可加入托管的入口。',
      });
    }
    return;
  }

  for (const candidate of final) {
    const manager = await detectNodeManager(candidate.dir, candidate.pkg, rootManager);
    const group = addGroup(project, `node-${manager}`, `Node.js (${manager})`, 'Node.js', manager);
    addApp(group, project, {
      id: `node:${candidate.dir}:${candidate.script.name}`,
      name: candidate.pkg.name ?? basename(candidate.dir),
      dir: candidate.dir,
      runner: 'node',
      command: manager,
      args: ['run', candidate.script.name],
      scriptName: candidate.script.name,
      reason: `${candidate.script.reason}；Node.js (${manager}) ${
        candidate.dir === root ? '根包' : '工作区包'
      }`,
    });
  }
}

/**
 * 解析 pom.xml 里我们需要的字段。只做保守的正则提取，不做完整 XML 解析。
 * @param {string} text
 */
function parsePom(text) {
  const withoutParent = text.replace(/<parent>[\s\S]*?<\/parent>/g, '');
  const artifactId = withoutParent.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1]?.trim();
  const modules = [...withoutParent.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)]
    .map((match) => (match[1] ?? '').trim())
    .filter((module) => module !== '' && !module.includes('..') && !module.startsWith('/'));
  const mainClass = withoutParent.match(/<mainClass>\s*([^<]+?)\s*<\/mainClass>/)?.[1]?.trim();
  return {
    artifactId,
    modules,
    hasSpringBoot: /spring-boot-maven-plugin/.test(text),
    mainClass,
  };
}

/**
 * 在 src/main/java 下找 @SpringBootApplication，作为 mainClass 缺失时的兜底。
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function hasSpringBootAnnotation(dir) {
  /** @type {{dir: string, depth: number}[]} */
  const stack = [{ dir: join(dir, 'src', 'main', 'java'), depth: 0 }];
  let readFiles = 0;
  while (stack.length > 0 && readFiles < MAX_JAVA_FILES) {
    const item = stack.pop();
    if (!item || item.depth > 8) continue;
    let entries;
    try {
      entries = await readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) {
          stack.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.java')) continue;
      readFiles += 1;
      if (readFiles > MAX_JAVA_FILES) break;
      try {
        const text = await readFile(join(item.dir, entry.name), 'utf8');
        if (text.includes('@SpringBootApplication')) return true;
      } catch {
        // 读不到的源文件不影响整体判定
      }
    }
  }
  return false;
}

/**
 * Java / Maven：聚合 POM 的模块，或单模块 Spring Boot。
 * @param {Project} project
 * @param {ScanState} state
 */
async function detectMaven(project, state) {
  const root = project.root;
  const pomFile = join(root, 'pom.xml');
  if (!(await isFile(pomFile))) return;

  let pomText;
  try {
    pomText = await readFile(pomFile, 'utf8');
  } catch (error) {
    project.diagnostics.push({
      path: pomFile,
      message: `读取 pom.xml 失败：${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  const pom = parsePom(pomText);
  const wrapper = join(root, 'mvnw');
  const command = (await isExecutable(wrapper)) ? './mvnw' : 'mvn';
  /** @type {{ module: string, artifactId?: string, mainClass?: string }[]} */
  const runnable = [];

  if (pom.modules.length > 0) {
    for (const module of pom.modules) {
      const moduleDir = join(root, module);
      const modulePomFile = join(moduleDir, 'pom.xml');
      if (!(await isFile(modulePomFile))) {
        project.diagnostics.push({
          path: modulePomFile,
          message: `pom.xml 声明了模块 ${module}，但该模块没有 pom.xml。`,
        });
        continue;
      }
      let moduleText;
      try {
        moduleText = await readFile(modulePomFile, 'utf8');
      } catch {
        continue;
      }
      const modulePom = parsePom(moduleText);
      if (!modulePom.hasSpringBoot) continue;
      const annotation = modulePom.mainClass ? true : await hasSpringBootAnnotation(moduleDir);
      if (!annotation) continue;
      runnable.push({
        module,
        artifactId: modulePom.artifactId,
        mainClass: modulePom.mainClass,
      });
    }
  } else if (pom.hasSpringBoot) {
    const annotation = pom.mainClass ? true : await hasSpringBootAnnotation(root);
    if (annotation)
      runnable.push({ module: '', artifactId: pom.artifactId, mainClass: pom.mainClass });
  }

  if (runnable.length === 0) {
    project.diagnostics.push({
      path: pomFile,
      message:
        'Maven 项目未发现 Spring Boot 可运行模块（需要 spring-boot-maven-plugin + mainClass 或 @SpringBootApplication）。',
    });
    return;
  }

  const group = addGroup(project, 'java-maven', 'Java (Maven)', 'Java', 'Maven');
  for (const item of runnable) {
    const args = item.module === '' ? ['spring-boot:run'] : ['-pl', item.module, 'spring-boot:run'];
    addApp(group, project, {
      id: `maven:${root}:${item.module || '.'}`,
      name: item.artifactId ?? (item.module || project.name),
      dir: root,
      runner: 'maven',
      command,
      args,
      reason: `${item.module ? `pom.xml 的 <module>${item.module}</module>` : '根 pom.xml'} + spring-boot-maven-plugin${
        item.mainClass ? ` + mainClass=${item.mainClass}` : ' + @SpringBootApplication'
      }；识别为 Java (Maven) 应用`,
    });
  }
  state.scannedDirs += 1;
}

/**
 * Gradle：只做 Spring Boot 项目的最小识别（根项目）。
 * @param {Project} project
 */
async function detectGradle(project) {
  const root = project.root;
  const buildFile = (await isFile(join(root, 'build.gradle')))
    ? join(root, 'build.gradle')
    : (await isFile(join(root, 'build.gradle.kts')))
      ? join(root, 'build.gradle.kts')
      : null;
  if (!buildFile) return;
  let text;
  try {
    text = await readFile(buildFile, 'utf8');
  } catch {
    return;
  }
  if (!/spring-boot|org\.springframework\.boot/i.test(text)) return;
  const wrapper = join(root, 'gradlew');
  const command = (await isExecutable(wrapper)) ? './gradlew' : 'gradle';
  const group = addGroup(project, 'java-gradle', 'Java (Gradle)', 'Java', 'Gradle');
  addApp(group, project, {
    id: `gradle:${root}:bootRun`,
    name: project.name,
    dir: root,
    runner: 'gradle',
    command,
    args: ['bootRun'],
    reason: 'build.gradle 含 Spring Boot 插件；识别为 Java (Gradle) 应用（只识别根项目）',
  });
}

/**
 * 判定一个 Composer 目录里能作为长期服务运行的入口。
 *
 * 只认框架明示的 CLI、composer 脚本，最后才退回 PHP 内置服务器。兜底之所以按
 * `public/index.php` 而不是某个启动脚本的名字：入口文件是框架事实，启动脚本的
 * 文件名与实现因项目而异，不能作为识别依据。
 *
 * @param {string} dir
 * @param {Record<string, any>} composer
 * @returns {Promise<{ entry: string, command: string, args: string[], reason: string, scriptName?: string } | null>}
 */
async function pickPhpEntry(dir, composer) {
  if (await isFile(join(dir, 'artisan'))) {
    return {
      entry: 'artisan',
      command: 'php',
      args: ['artisan', 'serve'],
      reason: '存在 artisan；识别为 Laravel / PHP (Composer) 应用',
    };
  }
  if (await isFile(join(dir, 'bin', 'console'))) {
    return {
      entry: 'console',
      command: 'php',
      args: ['bin/console', 'server:run'],
      reason: '存在 bin/console；识别为 Symfony / PHP (Composer) 应用',
    };
  }
  if (await isFile(join(dir, 'think'))) {
    const requires =
      composer.require && typeof composer.require === 'object' && !Array.isArray(composer.require)
        ? composer.require
        : {};
    const usesThinkPhp = Object.keys(requires).some((name) => name === 'topthink/framework');
    if (usesThinkPhp) {
      return {
        entry: 'think',
        command: 'php',
        args: ['think', 'run', '--host=127.0.0.1', '--port=8000'],
        reason:
          '存在 think CLI 且 composer.json 依赖 topthink/framework；识别为 ThinkPHP / PHP (Composer) 应用',
      };
    }
  }
  const scripts =
    composer.scripts && typeof composer.scripts === 'object' && !Array.isArray(composer.scripts)
      ? composer.scripts
      : {};
  const picked = selectRunScripts(scripts);
  if (picked.length > 0) {
    const primary = pickPrimaryScript(picked);
    return {
      entry: primary.name,
      command: 'composer',
      args: ['run', primary.name],
      scriptName: primary.name,
      reason: `composer.json 的 scripts["${primary.name}"]；识别为 PHP (Composer) 应用`,
    };
  }
  if (await isFile(join(dir, 'public', 'index.php'))) {
    const hasRouter = await isFile(join(dir, 'public', 'router.php'));
    return {
      entry: hasRouter ? 'public/router.php' : 'public/index.php',
      command: 'php',
      args: ['-S', '127.0.0.1:8000', '-t', 'public', ...(hasRouter ? ['public/router.php'] : [])],
      reason: hasRouter
        ? '存在 public/index.php 与 public/router.php；未发现框架启动入口，使用 PHP 内置服务器托管 public/ 目录'
        : '存在 public/index.php；未发现框架启动入口，使用 PHP 内置服务器托管 public/ 目录',
    };
  }
  return null;
}

/**
 * PHP / Composer：项目根与直接子目录里的 Composer 应用。
 *
 * 前后端同仓很常见（例如 `server/` + `pc/`），PHP 应用未必在项目根上；只扫根会
 * 漏掉整个后端，项目也就无法完整启动。子目录范围与 Node 的“第一层子包”一致，
 * 不进入嵌套 git 仓库。
 *
 * @param {Project} project
 * @param {ScanState} state
 */
async function detectPhp(project, state) {
  const root = project.root;
  /** @type {string[]} */
  const composerDirs = [];
  if (await isFile(join(root, 'composer.json'))) composerDirs.push(root);
  for (const child of await readChildDirs(root, state)) {
    const childPath = join(root, child);
    if (await isGitRepo(childPath)) continue;
    if (await isFile(join(childPath, 'composer.json'))) composerDirs.push(childPath);
  }
  if (composerDirs.length === 0) return;

  const group = addGroup(project, 'php-composer', 'PHP (Composer)', 'PHP', 'Composer');
  let detected = 0;
  /** @type {string[]} */
  const withoutEntry = [];
  for (const dir of composerDirs) {
    const composerFile = join(dir, 'composer.json');
    const composer = await readJsonObject(composerFile, project);
    if (!composer) continue;
    const entry = await pickPhpEntry(dir, composer);
    if (!entry) {
      withoutEntry.push(composerFile);
      continue;
    }
    addApp(group, project, {
      id: `php:${dir}:${entry.entry}`,
      name: dir === root ? (composer.name ?? project.name) : basename(dir),
      dir,
      runner: 'php',
      command: entry.command,
      args: entry.args,
      scriptName: entry.scriptName,
      reason: entry.reason,
    });
    detected += 1;
  }

  if (detected > 0) return;
  project.ecosystems = project.ecosystems.filter((item) => item.id !== group.id);
  for (const composerFile of withoutEntry) {
    project.diagnostics.push({
      path: composerFile,
      message:
        'PHP / Composer 项目未发现 artisan、bin/console、think 入口、dev/start 脚本或 public/index.php。',
    });
  }
}

/**
 * Flutter / Dart：pubspec.yaml 依赖 flutter 时识别为 Flutter 应用。
 * @param {Project} project
 */
async function detectFlutter(project) {
  const root = project.root;
  const pubspecFile = join(root, 'pubspec.yaml');
  if (!(await isFile(pubspecFile))) return;
  let text;
  try {
    text = await readFile(pubspecFile, 'utf8');
  } catch {
    return;
  }
  const name = text.match(/^name:\s*([^\s#]+)/m)?.[1];
  const isFlutter = /sdk:\s*flutter/.test(text) || /^\s*flutter:\s*$/m.test(text);
  const hasDartMain = await isFile(join(root, 'lib', 'main.dart'));
  if (!isFlutter && !hasDartMain) return;

  const group = addGroup(project, 'flutter-pub', 'Flutter (pub)', 'Flutter', 'pub');
  addApp(group, project, {
    id: `flutter:${root}:run`,
    name: name ?? project.name,
    dir: root,
    runner: 'flutter',
    command: 'flutter',
    args: ['run'],
    reason: isFlutter
      ? 'pubspec.yaml 依赖 flutter；识别为 Flutter (pub) 应用（flutter run 可能提示选择设备）'
      : '存在 lib/main.dart；识别为 Dart/Flutter 应用',
  });
}

/**
 * Go：go.mod + package main。
 * @param {Project} project
 * @param {ScanState} state
 */
async function detectGo(project, state) {
  const root = project.root;
  if (!(await isFile(join(root, 'go.mod')))) return;

  /** @type {{ dir: string, args: string[], name: string }[]} */
  const runnable = [];
  if (await isMainGoFile(join(root, 'main.go'))) {
    runnable.push({ dir: root, args: ['run', '.'], name: project.name });
  }
  for (const child of await readChildDirs(root, state)) {
    const childPath = join(root, child);
    const childFiles = await readFileNames(childPath, state);
    let isMain = false;
    if (child === 'cmd') {
      for (const commandDir of await readChildDirs(childPath, state)) {
        const commandPath = join(childPath, commandDir);
        if (await isMainGoFile(join(commandPath, 'main.go'))) {
          runnable.push({
            dir: root,
            args: ['run', `./cmd/${commandDir}`],
            name: commandDir,
          });
        }
      }
      continue;
    }
    if (childFiles.has('main.go')) isMain = await isMainGoFile(join(childPath, 'main.go'));
    if (isMain) runnable.push({ dir: root, args: ['run', `./${child}`], name: child });
  }

  if (runnable.length === 0) {
    project.diagnostics.push({
      path: join(root, 'go.mod'),
      message: 'Go 项目未发现 package main 入口（main.go 或 cmd/*）。',
    });
    return;
  }
  const group = addGroup(project, 'go-modules', 'Go (modules)', 'Go', 'modules');
  for (const item of runnable) {
    addApp(group, project, {
      id: `go:${root}:${item.args.slice(1).join('/') || '.'}`,
      name: item.name,
      dir: item.dir,
      runner: 'go',
      command: 'go',
      args: item.args,
      reason: `go.mod + ${item.args.join(' ')}；识别为 Go (modules) 应用`,
    });
  }
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function isMainGoFile(file) {
  try {
    const text = await readFile(file, 'utf8');
    return /^package\s+main\b/m.test(text);
  } catch {
    return false;
  }
}

/**
 * Rust / Cargo：单包或 workspace 成员里的 bin。
 * @param {Project} project
 * @param {ScanState} state
 */
async function detectRust(project, state) {
  const root = project.root;
  const cargoFile = join(root, 'Cargo.toml');
  if (!(await isFile(cargoFile))) return;
  let text;
  try {
    text = await readFile(cargoFile, 'utf8');
  } catch {
    return;
  }
  const packageName = text.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  const membersBlock = text.match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/);
  /** @type {{ root: string, name: string, package: boolean }[]} */
  const packages = [];

  if (membersBlock) {
    const members = [...(membersBlock[1] ?? '').matchAll(/"([^"]+)"/g)]
      .map((match) => match[1] ?? '')
      .filter((member) => !member.includes('..') && !member.startsWith('/'));
    for (const member of members) {
      for (const dir of await expandGlob(root, member, state)) {
        const memberCargo = join(dir, 'Cargo.toml');
        if (!(await isFile(memberCargo))) continue;
        let memberText;
        try {
          memberText = await readFile(memberCargo, 'utf8');
        } catch {
          continue;
        }
        const memberName = memberText.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
        const hasBin =
          (await isFile(join(dir, 'src', 'main.rs'))) || /\[\[bin\]\]/.test(memberText);
        if (hasBin) {
          packages.push({ root, name: memberName ?? basename(dir), package: true });
        }
      }
    }
  } else if ((await isFile(join(root, 'src', 'main.rs'))) || /\[\[bin\]\]/.test(text)) {
    packages.push({ root, name: packageName ?? project.name, package: false });
  }

  if (packages.length === 0) {
    project.diagnostics.push({
      path: cargoFile,
      message: 'Rust / Cargo 项目未发现 src/main.rs 或 [[bin]]。',
    });
    return;
  }
  const group = addGroup(project, 'rust-cargo', 'Rust (Cargo)', 'Rust', 'Cargo');
  for (const item of packages) {
    addApp(group, project, {
      id: `rust:${root}:${item.package ? item.name : '.'}`,
      name: item.name,
      dir: root,
      runner: 'rust',
      command: 'cargo',
      args: item.package ? ['run', '-p', item.name] : ['run'],
      reason: `Cargo.toml${item.package ? ' 的 workspace 成员' : ''}含可执行入口；识别为 Rust (Cargo) 应用`,
    });
  }
}

/**
 * Python：manage.py / main.py / app.py / server.py。
 * @param {Project} project
 * @param {ScanState} state
 */
async function detectPython(project, state) {
  const root = project.root;
  const files = await readFileNames(root, state);
  if (!files.has('manage.py') && !files.has('pyproject.toml') && !files.has('requirements.txt')) {
    return;
  }
  const manager = (await isFile(join(root, 'uv.lock')))
    ? 'uv'
    : (await isFile(join(root, 'poetry.lock')))
      ? 'poetry'
      : (await isFile(join(root, 'Pipfile.lock')))
        ? 'pipenv'
        : 'pip';
  const group = addGroup(project, `python-${manager}`, `Python (${manager})`, 'Python', manager);

  if (files.has('manage.py')) {
    addApp(group, project, {
      id: `python:${root}:manage.py`,
      name: project.name,
      dir: root,
      runner: 'python',
      command: 'python3',
      args: ['manage.py', 'runserver'],
      reason: '存在 manage.py（Django 入口）；识别为 Python 应用',
    });
    return;
  }

  for (const entry of ['main.py', 'app.py', 'server.py']) {
    if (!files.has(entry)) continue;
    if (!files.has('requirements.txt') && !files.has('pyproject.toml') && !files.has('Pipfile')) {
      continue;
    }
    addApp(group, project, {
      id: `python:${root}:${entry}`,
      name: project.name,
      dir: root,
      runner: 'python',
      command: 'python3',
      args: [entry],
      reason: `存在 ${entry} 且有依赖声明；识别为 Python (${manager}) 应用`,
    });
    return;
  }

  project.ecosystems = project.ecosystems.filter((item) => item.id !== group.id);
  project.diagnostics.push({
    path: join(root, 'pyproject.toml'),
    message: 'Python 项目未发现 manage.py / main.py / app.py / server.py 入口。',
  });
}

/**
 * Shell：scripts/ 或 bin/ 下可执行的 .sh。
 * @param {Project} project
 */
async function detectShell(project) {
  const root = project.root;
  for (const sub of ['scripts', 'bin']) {
    const subPath = join(root, sub);
    if (!(await isDirectory(subPath))) continue;
    let entries;
    try {
      entries = await readdir(subPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== '.sh') continue;
      if (!(await isExecutable(join(subPath, entry.name)))) continue;
      const group = addGroup(project, 'shell-scripts', 'Shell (scripts)', 'Shell', 'scripts');
      addApp(group, project, {
        id: `shell:${root}:${entry.name}`,
        name: `${project.name}:${entry.name}`,
        dir: root,
        runner: 'shell',
        command: 'bash',
        args: [join(sub, entry.name)],
        reason: `${sub}/${entry.name} 存在且可执行；识别为 Shell 应用`,
      });
    }
  }
}

/**
 * 扫描一个项目：识别生态分组与可运行应用。
 * @param {string} root
 * @param {ContainerInfo | null} container
 * @param {ScanState} state
 * @returns {Promise<Project>}
 */
async function scanProject(root, container, state) {
  state.scannedDirs += 1;
  const source = (await isGitRepo(root)) ? 'git' : 'manifest';
  const project = /** @type {Project} */ ({
    id: `project:${root}`,
    name: basename(root),
    root,
    source,
    container,
    ecosystems: [],
    diagnostics: [],
  });

  await detectNode(project, state);
  await detectMaven(project, state);
  await detectGradle(project);
  await detectPhp(project, state);
  await detectFlutter(project);
  await detectGo(project, state);
  await detectRust(project, state);
  await detectPython(project, state);
  await detectShell(project);

  project.ecosystems = project.ecosystems.filter((group) => group.apps.length > 0);
  if (project.ecosystems.length === 0 && project.diagnostics.length === 0) {
    project.diagnostics.push({ path: root, message: '未发现可识别的语言生态或可运行应用。' });
  }
  return project;
}

/**
 * 扫描一个根目录，返回项目列表。
 * @param {string} root
 * @param {{ maxDirs?: number }} [_options]
 * @returns {Promise<ProjectScanResult>}
 */
/**
 * 递归发现项目：遇到 git 仓库就把它当作项目并停止向下；没有 git 的目录继续找子目录。
 *
 * 这正是“发现 git 后不递归”的准确含义：递归只发生在非项目目录里。一个普通文件夹
 * （例如把一组仓库放在一起的 `tian-gong-one`）本身不是项目，但它在任意深度找到的
 * 直接 git 仓库都是项目；离项目最近的非 git 祖先成为它的容器标签。
 *
 * @param {string} dir
 * @param {ContainerInfo | null} container
 * @param {number} depth
 * @param {ScanState} state
 * @param {Project[]} projects
 */
async function discoverProjects(dir, container, depth, state, projects) {
  if (depth > MAX_PROJECT_DEPTH || projects.length >= MAX_PROJECTS) return;
  for (const child of await readChildDirs(dir, state)) {
    if (projects.length >= MAX_PROJECTS) return;
    const childPath = join(dir, child);

    // 发现 git：项目边界，绝不继续向下递归。
    if (await isGitRepo(childPath)) {
      projects.push(await scanProject(childPath, container, state));
      continue;
    }

    // 没有 git：继续扫描子目录。若找到项目，这一层就只是容器。
    const childContainer = { id: `container:${childPath}`, name: child, root: childPath };
    const before = projects.length;
    await discoverProjects(childPath, childContainer, depth + 1, state, projects);
    if (projects.length > before) continue;

    // 没有找到子项目，但有项目清单：它自己是一个无 git 项目。
    if (await hasProjectManifest(childPath)) {
      projects.push(await scanProject(childPath, container, state));
    }
  }
}

/**
 * 扫描一个根目录，返回项目列表。
 *
 * - 根自身是 git 仓库 → 只算这一个项目，不进入项目内部找子项目。
 * - 根没有 git → 递归穿过非 git 目录，直到发现 git 仓库；中间的非 git 文件夹成为容器。
 * - 根没有 git、但有项目清单且内部没有子项目 → 根自身作为无 git 项目。
 *
 * @param {string} root
 * @param {{ maxDirs?: number }} [_options]
 * @returns {Promise<ProjectScanResult>}
 */
export async function scanProjects(root, _options = {}) {
  const state = /** @type {ScanState} */ ({ scannedDirs: 0, diagnostics: [] });
  const absolute = resolve(root);
  /** @type {Project[]} */
  const projects = [];

  if (await isGitRepo(absolute)) {
    projects.push(await scanProject(absolute, null, state));
  } else {
    await discoverProjects(absolute, null, 0, state, projects);
    if (projects.length === 0 && (await hasProjectManifest(absolute))) {
      projects.push(await scanProject(absolute, null, state));
    }
  }

  projects.sort((a, b) => {
    const containerA = a.container?.name ?? '';
    const containerB = b.container?.name ?? '';
    if (containerA !== containerB) return containerA.localeCompare(containerB);
    return a.name.localeCompare(b.name);
  });

  return {
    projects,
    diagnostics: state.diagnostics,
    scannedDirs: Math.min(state.scannedDirs, MAX_DIRS),
  };
}

/**
 * 把项目树里的应用拍平成列表，供服务层标记/查找。
 * @param {Project[]} projects
 * @returns {RunnableApp[]}
 */
export function flattenApps(projects) {
  /** @type {RunnableApp[]} */
  const apps = [];
  for (const project of projects) {
    for (const group of project.ecosystems) {
      apps.push(...group.apps);
    }
  }
  return apps;
}
