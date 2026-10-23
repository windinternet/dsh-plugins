/**
 * 进程组资源采样。
 *
 * 为什么要按进程组而不是只看主 pid：dockyard 用 detached 方式启动服务，服务自己拉起的
 * 子进程（Maven fork 的 JVM、Node 的 worker 等）才是真正吃 CPU/内存的东西。只统计主 pid
 * 会系统性低估。
 *
 * 平台实现：macOS / Linux 都用 `ps -axo pid,pgid,%cpu,rss` 一次性列出全部进程再过滤。
 * 不解析 `/proc` 是为了少写一套平台分支；`ps` 在这两个平台都稳定存在。Windows 暂不支持，
 * 返回 null，界面显示“无数据”而不是编一个 0。
 *
 * 读数语义：
 * - `%cpu` 是该进程（组）的 CPU 占用百分比，可能超过 100（多核）；
 * - `rss` 是常驻内存，按进程求和，共享页会重复计算，所以它是“上界估计”而非精确值。
 * 这两点会在工具描述与界面里标明，避免把近似值当精确值。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @typedef {object} ProcessMetrics
 * @property {number} cpuPercent
 * @property {number} rssBytes
 * @property {number} processCount
 * @property {number} at
 */

/**
 * 解析 `ps -axo pid=,pgid=,%cpu=,rss=` 的输出，聚合同一个进程组的 CPU 与 RSS。
 * @param {string} text
 * @param {number} pid
 * @returns {ProcessMetrics | null}
 */
export function parsePsOutput(text, pid) {
  let cpu = 0;
  let rssKb = 0;
  let processCount = 0;
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)$/);
    if (!match) continue;
    const processId = Number(match[1]);
    const groupId = Number(match[2]);
    if (processId !== pid && groupId !== pid) continue;
    cpu += Number(match[3]);
    rssKb += Number(match[4]);
    processCount += 1;
  }
  if (processCount === 0) return null;
  return {
    cpuPercent: Math.round(cpu * 10) / 10,
    rssBytes: rssKb * 1024,
    processCount,
    at: Date.now(),
  };
}

/**
 * 采样一个进程组。失败、进程已消失、平台不支持都返回 null，不抛异常。
 * @param {number} pid
 * @param {{ platform?: NodeJS.Platform, timeoutMs?: number }} [options]
 * @returns {Promise<ProcessMetrics | null>}
 */
export async function sampleProcessGroup(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform !== 'darwin' && platform !== 'linux') return null;
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,%cpu=,rss='], {
      timeout: options.timeoutMs ?? 1500,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return parsePsOutput(String(stdout), pid);
  } catch {
    return null;
  }
}
