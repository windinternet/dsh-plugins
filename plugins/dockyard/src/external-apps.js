/**
 * 把外部进程匹配回已托管的应用。
 *
 * 为什么要做匹配：外部进程只能按 cwd / 命令行归到项目，但面板与接管操作的单位是应用。
 * 匹配必须偏保守——宁可标成"未识别"，也不要把一个进程算到多个应用上，否则
 * "接管这个应用"会误杀别的服务。匹配依据按可信度从高到低：
 *
 * 1. 进程 cwd 与应用目录完全一致；
 * 2. cwd 在应用目录之下；
 * 3. cwd 是项目根，且命令行带 `-pl <模块>` / `--filter <包名>` 等明确的模块选择；
 * 4. cwd 是项目根，且命令行里出现应用名或目录名。
 *
 * 分数相同即视为歧义，直接放弃匹配。调用方会把这类进程列为"未识别外部进程"。
 */

import { basename, sep } from 'node:path';

/**
 * 判断 child 是否在 parent 之下（包含 parent 本身）。
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isInside(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || parent === '') return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * 给一个外部进程与一条应用记录打分。0 表示不确定或无关。
 * @param {{ cwd?: string, command?: string }} process
 * @param {{ name?: string, dir?: string, args?: string[], projectRoot?: string }} record
 * @returns {number}
 */
export function scoreExternalProcess(process, record) {
  const cwd = typeof process.cwd === 'string' ? process.cwd : '';
  const dir = typeof record.dir === 'string' ? record.dir : '';
  if (cwd === '' || dir === '') return 0;

  let score = 0;
  if (cwd === dir) score += 100;
  else if (isInside(cwd, dir)) score += 70;
  else if (record.projectRoot && cwd === record.projectRoot) score += 10;
  else if (record.projectRoot && isInside(cwd, record.projectRoot)) score += 5;
  else return 0;

  const command = String(process.command ?? '').toLowerCase();
  const tokens = command.split(/\s+/).filter(Boolean);
  const name = String(record.name ?? '').toLowerCase();
  const dirName = basename(dir).toLowerCase();

  // 命令行里出现应用名/目录名时给一点分，但不足以单独决定归属。
  if (name && tokens.includes(name)) score += 35;
  if (dirName && dirName !== name && tokens.includes(dirName)) score += 25;

  // Maven 多模块：-pl api 是比 cwd 更精确的归属证据。
  const moduleFlag = command.match(/(?:^|\s)-pl\s+([^\s]+)/);
  if (moduleFlag) {
    const target = (moduleFlag[1] ?? '')
      .replace(/^\.?\//, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (
      name &&
      (target === name ||
        target === dirName ||
        target.endsWith(`/${name}`) ||
        target.endsWith(`/${dirName}`))
    ) {
      score += 70;
    }
  }

  // pnpm --filter / turbo --filter：工作区包的显式选择。
  const filterFlag = command.match(/(?:^|\s)(?:--filter|-F)\s+([^\s]+)/);
  if (filterFlag && name) {
    const target = (filterFlag[1] ?? '').toLowerCase();
    if (target.includes(name) || (dirName && target.includes(dirName))) score += 60;
  }

  // 命令行里出现 /应用名 路径（例如 java -jar /repo/api/target/app.jar）。
  if (name.length >= 2 && command.includes(`/${name}`)) score += 15;

  return score;
}

/**
 * 把进程列表按应用聚合。返回的 apps 只包含成功匹配的应用；
 * unmatched 是匹配不到、或有歧义的进程，供调用方展示"未识别外部进程"。
 *
 * @param {any[]} records 已托管应用记录（store.list()）
 * @param {any[]} processes listExternalProcesses() 的结果
 * @returns {{ apps: any[], unmatched: any[] }}
 */
export function matchExternalApps(records, processes) {
  /** @type {Map<string, { record: any, processes: any[], score: number }>} */
  const grouped = new Map();
  /** @type {any[]} */
  const unmatched = [];

  for (const process of processes) {
    /** @type {{ record: any, score: number } | null} */
    let best = null;
    let ambiguous = false;
    for (const record of records) {
      if (!record || record.missing === true) continue;
      const score = scoreExternalProcess(process, record);
      if (score < 30) continue;
      if (!best || score > best.score) {
        best = { record, score };
        ambiguous = false;
      } else if (score === best.score) {
        ambiguous = true;
      }
    }
    if (!best || ambiguous) {
      unmatched.push(process);
      continue;
    }
    let entry = grouped.get(best.record.id);
    if (!entry) {
      entry = { record: best.record, processes: [], score: best.score };
      grouped.set(best.record.id, entry);
    }
    entry.processes.push(process);
    entry.score = Math.max(entry.score, best.score);
  }

  const apps = [...grouped.values()].map((entry) => {
    const unique = new Map();
    for (const process of entry.processes) unique.set(process.pid, process);
    const processesForApp = [...unique.values()].sort(
      (a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0) || a.pid - b.pid,
    );
    const representative = processesForApp[0];
    const ports = [...new Set(processesForApp.flatMap((process) => process.ports ?? []))].sort(
      (a, b) => a - b,
    );
    return {
      id: entry.record.id,
      name: entry.record.name,
      projectId: entry.record.projectId,
      projectName: entry.record.projectName,
      projectRoot: entry.record.projectRoot,
      dir: entry.record.dir,
      command: entry.record.command,
      args: Array.isArray(entry.record.args) ? entry.record.args : [],
      language: entry.record.language,
      manager: entry.record.manager,
      managed: false,
      status: 'running',
      statusReason: '由外部启动，dockyard 只做只读观测。',
      cpuPercent: processesForApp.reduce((sum, process) => sum + (process.cpuPercent ?? 0), 0),
      rssBytes: processesForApp.reduce((sum, process) => sum + (process.rssBytes ?? 0), 0),
      pids: processesForApp.map((process) => process.pid),
      ports,
      cwd: representative?.cwd ?? entry.record.dir,
      externalCommand: representative?.command ?? '',
      matchScore: entry.score,
      processes: processesForApp,
    };
  });

  apps.sort(
    (a, b) =>
      String(a.projectName ?? '').localeCompare(String(b.projectName ?? '')) ||
      String(a.name ?? '').localeCompare(String(b.name ?? '')),
  );
  return { apps, unmatched };
}

/**
 * 计算接管一个外部应用时需要终止的 pid 集合：匹配到的进程，以及项目内的祖先链。
 * 父进程可能是 pnpm/turbo/mvn，只杀子进程会被父进程重新拉起。
 *
 * @param {any[]} appProcesses 匹配到该应用的外部进程
 * @param {any[]} allProcesses 同一项目下的全部外部进程
 * @param {string} projectRoot
 * @returns {any[]} 需要终止的进程对象（去重）
 */
export function collectStopProcesses(appProcesses, allProcesses, projectRoot) {
  const byPid = new Map(allProcesses.map((process) => [process.pid, process]));
  const targets = new Map();
  for (const process of appProcesses) {
    targets.set(process.pid, process);
    let cursor = process.ppid;
    for (let depth = 0; depth < 32 && cursor > 1; depth += 1) {
      const parent = byPid.get(cursor);
      if (!parent) break;
      if (projectRoot && !isInside(parent.cwd ?? '', projectRoot)) break;
      targets.set(parent.pid, parent);
      cursor = parent.ppid;
    }
  }
  return [...targets.values()];
}
