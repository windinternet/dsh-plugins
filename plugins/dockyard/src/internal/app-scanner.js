/**
 * 本文件是 packages/plugin-kit/src/app-scanner.js 的同步副本。
 *
 * 为什么要复制而不是直接 import：本仓库的插件必须能独立安装到任意 DSH profile。
 * 实测结论是外部 profile 只认可已安装的 spec——`workspace:*` 必然失败，
 * 而未发布的包也没有可安装的引用方式。官方插件同样只用真实版本号引依赖。
 *
 * 因此这里接受"同步副本"这个取舍：单一消费者时复制比引入发布流程简单得多。
 * 同步方式见本插件的 README「开发备注」一节。
 */
/**
 * 项目扫描：判定一个目录里有没有可运行的应用，并给出判定理由。
 *
 * 为什么坚持"给出理由"：识别本质上是有损的推断。用户需要能判断推断对不对，
 * 智能体需要能据此推理为什么某个项目没被识别出来。一个只给出结论的扫描器
 * 会让人反复猜测它的规则，那就退化成了黑盒——而黑盒正是要避免的东西。
 *
 * 边界约束：所有读到的文件内容都是不可信的。这里对每个字段做类型与形状校验，
 * 拒绝的输入会变成诊断信息，而不是一路带着脏数据往下走。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';

/** 扫描时永不进入的目录。 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
]);

/**
 * 一个候选应用的形状。
 * @typedef {object} AppCandidate
 * @property {string} id 稳定标识，由目录与入口推导
 * @property {string} name 展示名
 * @property {string} dir 应用所在目录（绝对路径）
 * @property {'node'|'python'|'shell'} runner 运行器类型
 * @property {string} command 启动命令（可执行文件）
 * @property {string[]} args 启动参数
 * @property {string} reason 判定理由：依据哪个文件、哪一行、识别成什么
 * @property {string} [scriptName] Node 项目里的 script 名
 */

/**
 * @typedef {object} ScanDiagnostic
 * @property {string} path 相关文件路径
 * @property {string} message 问题说明
 */

/**
 * @typedef {object} ScanResult
 * @property {AppCandidate[]} apps
 * @property {ScanDiagnostic[]} diagnostics 被拒绝或跳过的原因，供用户判断推断是否可信
 * @property {number} scannedDirs 实际检查的目录数
 */

/**
 * 判断一个名称是否是永远跳过的目录。
 * @param {string} name
 * @returns {boolean}
 */
export function isIgnoredDir(name) {
  return IGNORED_DIRS.has(name) || name.startsWith('.');
}

/**
 * 从 package.json 的 scripts 里挑出可以作为"应用"的脚本。
 *
 * 判定规则刻意保守：只认语义上表示"跑起来一个长期服务"的脚本名。
 * 把 test、lint、build 也当应用会让扫描结果里塞满噪音，用户很快就不会再看了。
 *
 * @param {Record<string, unknown>} scripts
 * @returns {{ name: string, reason: string }[]}
 */
export function selectRunScripts(scripts) {
  /** @type {{ name: string, reason: string }[]} */
  const picked = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string' || command.trim() === '') continue;
    // 排除明确的非服务型脚本
    if (
      /^(?:test|lint|format|build|typecheck|check|docs?|prepare|release|publish|clean)/i.test(name)
    ) {
      continue;
    }
    const isServerish =
      /^(?:dev|start|serve|server|run|watch)/i.test(name) ||
      /(?:^|:)(?:dev|start|serve|server|watch)$/i.test(name);
    if (isServerish) {
      picked.push({
        name,
        reason: `package.json 的 scripts["${name}"] = ${JSON.stringify(command)}`,
      });
    }
  }
  return picked;
}

/**
 * 解析 package.json 内容，做边界校验。返回 null 表示内容不可信。
 * @param {string} text
 * @param {string} file
 * @param {ScanDiagnostic[]} diagnostics
 * @returns {{ name?: string, scripts: Record<string, unknown> } | null}
 */
export function parsePackageJson(text, file, diagnostics) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    diagnostics.push({
      path: file,
      message: `package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.push({ path: file, message: 'package.json 顶层不是对象，已跳过。' });
    return null;
  }
  const scripts = parsed.scripts;
  if (
    scripts !== undefined &&
    (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts))
  ) {
    diagnostics.push({ path: file, message: 'package.json 的 scripts 不是对象，已忽略该字段。' });
  }
  return {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    scripts: scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : {},
  };
}

/**
 * 从一个目录扫描出候选应用。
 *
 * @param {string} root 扫描根目录（绝对路径）
 * @param {{ maxDepth?: number, maxDirs?: number }} [options]
 * @returns {Promise<ScanResult>}
 */
export async function scanForApps(root, options = {}) {
  const maxDepth = options.maxDepth ?? 4;
  const maxDirs = options.maxDirs ?? 2000;

  /** @type {AppCandidate[]} */
  const apps = [];
  /** @type {ScanDiagnostic[]} */
  const diagnostics = [];
  let scannedDirs = 0;

  /**
   * @param {string} dir
   * @param {number} depth
   */
  async function walk(dir, depth) {
    if (depth > maxDepth || scannedDirs >= maxDirs) return;
    scannedDirs += 1;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({
        path: dir,
        message: `无法读取目录：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const subDirs = entries
      .filter((e) => e.isDirectory() && !isIgnoredDir(e.name))
      .map((e) => e.name);

    // --- Node ---
    if (fileNames.has('package.json')) {
      const file = join(dir, 'package.json');
      try {
        const text = await readFile(file, 'utf8');
        const pkg = parsePackageJson(text, file, diagnostics);
        if (pkg) {
          const picked = selectRunScripts(pkg.scripts);
          const primary = picked[0];
          if (primary) {
            apps.push({
              id: `node:${dir}:${primary.name}`,
              name: pkg.name ?? basename(dir),
              dir,
              runner: 'node',
              command: 'npm',
              args: ['run', primary.name],
              scriptName: primary.name,
              reason: `${primary.reason}；识别为 node 应用`,
            });
            if (picked.length > 1) {
              diagnostics.push({
                path: file,
                message: `另有 ${picked.length - 1} 个可运行脚本未列为候选：${picked
                  .slice(1)
                  .map((p) => p.name)
                  .join('、')}`,
              });
            }
          }
        }
      } catch (error) {
        diagnostics.push({
          path: file,
          message: `读取失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // --- Python：只认明确的入口文件 ---
    /** @type {{ file: string, command: string, args: string[] }[]} */
    const pythonEntries = [
      { file: 'manage.py', command: 'python3', args: ['manage.py', 'runserver'] },
      { file: 'main.py', command: 'python3', args: ['main.py'] },
      { file: 'app.py', command: 'python3', args: ['app.py'] },
    ];
    for (const { file: fileName, command, args } of pythonEntries) {
      if (!fileNames.has(fileName)) continue;
      // main.py / app.py 太常见，要求同目录有依赖声明或虚拟环境线索才认
      if (fileName !== 'manage.py') {
        const hasSignal =
          fileNames.has('requirements.txt') ||
          fileNames.has('pyproject.toml') ||
          fileNames.has('Pipfile');
        if (!hasSignal) continue;
      }
      apps.push({
        id: `python:${dir}:${fileName}`,
        name: basename(dir),
        dir,
        runner: 'python',
        command,
        args,
        reason: `存在 ${fileName}${fileName === 'manage.py' ? '（Django 入口）' : '，且同目录有依赖声明'}；识别为 python 应用`,
      });
      break;
    }

    // --- Shell：只认 scripts/ 或 bin/ 下的可执行脚本 ---
    for (const sub of ['scripts', 'bin']) {
      if (!subDirs.includes(sub)) continue;
      const subPath = join(dir, sub);
      let subEntries;
      try {
        subEntries = await readdir(subPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of subEntries) {
        if (!entry.isFile() || extname(entry.name) !== '.sh') continue;
        const full = join(subPath, entry.name);
        try {
          const info = await stat(full);
          if ((info.mode & 0o111) === 0) continue; // 不可执行，不当应用
        } catch {
          continue;
        }
        apps.push({
          id: `shell:${dir}:${entry.name}`,
          name: `${basename(dir)}:${entry.name}`,
          dir,
          runner: 'shell',
          command: 'bash',
          args: [join(sub, entry.name)],
          reason: `${sub}/${entry.name} 存在且具有可执行权限；识别为 shell 应用`,
        });
      }
    }

    for (const name of subDirs) {
      await walk(join(dir, name), depth + 1);
    }
  }

  await walk(root, 0);

  // 同一目录可能被多个规则命中，去重时保留首个（Node 优先于 Shell 等）
  const seen = new Set();
  const deduped = apps.filter((app) => {
    const key = `${app.dir}#${app.runner}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { apps: deduped, diagnostics, scannedDirs };
}
