/**
 * 独立的日志中继 / 进程启动器。
 *
 * 为什么需要它：应用不能是 dockyard 或 DSH 的子进程，也不能把 stdout/stderr
 * 挂在父进程的管道上——DSH 一退出，管道关闭，应用写日志就会收到 EPIPE。
 * 这里让启动器自己成为 detached 会话的首进程，再把应用作为它的子进程启动：
 *
 * - 启动器退出不跟随 DSH；DSH 退出后启动器与应用都继续运行；
 * - 应用输出由启动器带上 OUT / ERR 前缀写入日志文件；
 * - 停止时对启动器所在进程组发信号，应用一起被回收；
 * - 日志文件大小达到上限时由启动器自己轮转，避免直接写 fd 无法轮转。
 *
 * 通过环境变量传递参数，避免把命令拼成 shell 字符串。
 */

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, renameSync, statSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

const logFile = process.env.DOCKYARD_LAUNCH_LOG ?? '';
const cwd = process.env.DOCKYARD_LAUNCH_CWD ?? '';
const command = process.env.DOCKYARD_LAUNCH_COMMAND ?? '';
const maxBytes = Number(process.env.DOCKYARD_LAUNCH_MAX_BYTES) || 8 * 1024 * 1024;
/** @type {string[]} */
let args = [];
try {
  const parsed = JSON.parse(process.env.DOCKYARD_LAUNCH_ARGS ?? '[]');
  if (Array.isArray(parsed)) args = parsed.filter((item) => typeof item === 'string');
} catch {
  args = [];
}

/** 清掉启动器自己的环境变量，别泄漏给被启动的应用。 */
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (key.startsWith('DOCKYARD_LAUNCH_')) delete childEnv[key];
}
childEnv.PATH = [dirname(process.execPath), process.env.PATH ?? ''].filter(Boolean).join(delimiter);

if (!logFile || !command || !cwd) {
  process.stderr.write('dockyard launcher: missing logFile/command/cwd\n');
  process.exit(2);
}

let fd = openSync(logFile, 'a');
let written = 0;
try {
  written = statSync(logFile).size;
} catch {
  written = 0;
}

/** @param {string} line */
function rotateIfNeeded(line) {
  if (written + Buffer.byteLength(line, 'utf8') <= maxBytes) return;
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
  for (let index = 2; index >= 1; index -= 1) {
    try {
      renameSync(`${logFile}.${index}`, `${logFile}.${index + 1}`);
    } catch {
      // ignore
    }
  }
  try {
    renameSync(logFile, `${logFile}.1`);
  } catch {
    // ignore
  }
  fd = openSync(logFile, 'a');
  written = 0;
}

/** @param {'OUT'|'ERR'|'SYS'} stream @param {string} text */
function write(stream, text) {
  const stamped = String(text)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => `[${new Date().toISOString().slice(11, 19)}] ${stream} ${line}\n`)
    .join('');
  if (stamped === '') return;
  rotateIfNeeded(stamped);
  appendFileSync(fd, stamped, 'utf8');
  written += Buffer.byteLength(stamped, 'utf8');
}

write('SYS', `启动：${command} ${args.join(' ')}`);

let child;
try {
  child = spawn(command, args, {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  write('SYS', `启动失败：${error instanceof Error ? error.message : String(error)}`);
  closeSync(fd);
  process.exit(1);
}

if (!child.pid) {
  write('SYS', '启动失败：没有拿到 pid');
  closeSync(fd);
  process.exit(1);
}
write('SYS', `已启动：pid ${child.pid}`);

child.stdout?.setEncoding('utf8');
child.stderr?.setEncoding('utf8');
child.stdout?.on('data', (chunk) => write('OUT', String(chunk)));
child.stderr?.on('data', (chunk) => write('ERR', String(chunk)));
child.on('error', (error) => {
  write('SYS', `进程错误：${error instanceof Error ? error.message : String(error)}`);
});

child.once('exit', (code, signal) => {
  write('SYS', `进程退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
  process.exit(code ?? 1);
});

// 启动器收到终止信号时把信号转给应用；应用退出后启动器也随之退出。
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      child?.kill(signal);
    } catch {
      // ignore
    }
  });
}
