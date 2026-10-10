import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startSupervisedProcess,
  stopSupervisedProcess,
  isProcessAlive,
  resolveStopTimings,
} from '../src/process-supervisor.js';

/**
 * 这一组测试会真的启动子进程。之所以不用 mock：进程监管的失败模式
 * （信号没生效、进程组没被回收、停止没等进程真正消失）恰恰只有真实进程才能暴露。
 * mock 会把这类 bug 全部藏起来，而它们正是这个模块存在的理由。
 */

/**
 * 创建一个临时工作目录，并在其中写一个脚本文件。
 *
 * @param {string} source 子脚本内容
 * @param {(context: { dir: string, script: string }) => Promise<void>} run
 */
async function withScript(source, run) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-kit-proc-'));
  const script = join(dir, 'child.mjs');
  await writeFile(script, source);
  try {
    return await run({ dir, script });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 保底清理：测试失败时不要让子进程变成孤儿。
 * @param {number} pid
 */
function forceKill(pid) {
  if (typeof pid !== 'number' || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退出
    }
  }
}

test('纯函数：resolveStopTimings 对非法输入取默认值并做上下界约束', () => {
  assert.deepEqual(resolveStopTimings(), {
    gracefulTimeoutMs: 5000,
    killTimeoutMs: 3000,
    pollIntervalMs: 100,
  });
  assert.equal(resolveStopTimings({ gracefulTimeoutMs: 10 }).gracefulTimeoutMs, 100);
  assert.equal(resolveStopTimings({ gracefulTimeoutMs: 10 ** 9 }).gracefulTimeoutMs, 120_000);
  assert.equal(resolveStopTimings({ pollIntervalMs: Number.NaN }).pollIntervalMs, 100);
});

test('isProcessAlive 对不存在的 pid 返回 false', () => {
  // 用一个几乎不可能存在的 pid
  assert.equal(isProcessAlive(2 ** 30), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});

test('isProcessAlive 对当前进程返回 true', () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test('启动后进程存活、状态为 running、pid 可读', async () => {
  await withScript('setInterval(() => {}, 1000);\n', async ({ dir, script }) => {
    let handle;
    try {
      /** @type {string[]} */
      const output = [];
      handle = await startSupervisedProcess({
        id: 'test-alive',
        command: process.execPath,
        args: [script],
        cwd: dir,
        onOutput: (_stream, text) => output.push(text),
      });

      assert.equal(handle.status, 'running');
      assert.ok(handle.pid > 0);
      assert.equal(isProcessAlive(handle.pid), true);
      assert.match(output.join(''), /已启动/);
    } finally {
      if (handle) await stopSupervisedProcess(handle, { gracefulTimeoutMs: 2000 });
      if (handle) forceKill(handle.pid);
    }
  });
});

test('停止能真正结束进程：状态变 stopped 且 pid 不再存在', async () => {
  await withScript(
    // 显式处理 SIGTERM，走正常的温和退出路径
    "process.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n",
    async ({ dir, script }) => {
      const handle = await startSupervisedProcess({
        id: 'test-stop',
        command: process.execPath,
        args: [script],
        cwd: dir,
      });
      const pid = handle.pid;
      assert.equal(isProcessAlive(pid), true);

      const result = await stopSupervisedProcess(handle, { gracefulTimeoutMs: 3000 });
      assert.equal(result.stopped, true);
      assert.equal(result.escalated, false);
      assert.equal(handle.status, 'stopped');
      assert.equal(isProcessAlive(pid), false, `pid ${pid} 在停止后仍然存在`);

      // 重复停止应当幂等成功
      const again = await stopSupervisedProcess(handle);
      assert.equal(again.stopped, true);
      assert.match(again.reason, /已不存在/);
    },
  );
});

test('温和终止不生效时升级为强杀（注入式，策略层确定性验证）', async () => {
  // 这条测试只验证"策略"：宽限窗口到期后必须升级，且必须等到进程真的消失。
  // 信号发送与存活探测都注入，因此不依赖真实进程时序，不会偶发失败，且毫秒级完成。
  /** @type {string[]} */
  const signals = [];

  const record = {
    id: 'policy',
    pid: 999_999_999,
    status: /** @type {const} */ ('running'),
    command: 'unused',
    args: [],
    cwd: '/',
    startedAt: Date.now(),
    ownsProcessGroup: true,
  };

  const result = await stopSupervisedProcess(record, {
    gracefulTimeoutMs: 5,
    killTimeoutMs: 2000,
    pollIntervalMs: 1,
    // 只挡 SIGTERM：发过强杀之后才认为进程消失，用来验证"升级后确实确认了退出"
    isAlive: () => !signals.includes('SIGKILL'),
    sendSignal: (_target, signal) => {
      signals.push(signal);
    },
  });

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], '应先温和终止，超时后升级为强杀');
  assert.equal(result.escalated, true);
  assert.equal(result.stopped, true);
  assert.equal(record.status, 'stopped');
  assert.match(result.reason, /SIGKILL/);
});

test('停止策略：进程始终不消失时不谎报成功', async () => {
  const record = {
    id: 'stubborn',
    pid: 999_999_998,
    status: /** @type {const} */ ('running'),
    command: 'unused',
    args: [],
    cwd: '/',
    startedAt: Date.now(),
    ownsProcessGroup: true,
  };

  const result = await stopSupervisedProcess(record, {
    gracefulTimeoutMs: 5,
    killTimeoutMs: 5,
    pollIntervalMs: 1,
    isAlive: () => true, // 永远活着
    sendSignal: () => {},
  });

  assert.equal(result.stopped, false, '回收失败时不能报告已停止');
  assert.equal(result.escalated, true);
  assert.equal(record.status, 'crashed');
  assert.match(result.reason, /状态不可信/);
});

test('非独立进程组时只对单个 pid 发信号，不对进程组下手', async () => {
  // 这是曾经真实踩到的坑：某些测试运行器把子进程放在同一个进程组里，
  // 对 -pid 发 SIGTERM 会把运行器自己所在的整组一起打掉。
  const realKill = process.kill;
  /** @type {{ target: number, signal: string }[]} */
  const calls = [];
  // @ts-expect-error 测试中临时替换全局函数
  process.kill = (target, signal) => {
    calls.push({ target: Number(target), signal: String(signal) });
  };
  try {
    const record = {
      id: 'no-group',
      pid: 4242,
      status: /** @type {const} */ ('running'),
      command: 'unused',
      args: [],
      cwd: '/',
      startedAt: Date.now(),
      ownsProcessGroup: false,
    };
    const result = await stopSupervisedProcess(record, {
      gracefulTimeoutMs: 5,
      killTimeoutMs: 2000,
      pollIntervalMs: 1,
      // 发过信号即视为已退出，让流程收敛
      isAlive: () => calls.length === 0,
    });
    assert.equal(result.stopped, true);
  } finally {
    process.kill = realKill;
  }

  const first = calls[0];
  assert.ok(first, '应当发过信号');
  for (const call of calls) {
    assert.equal(call.target, 4242, '不应对负 pid（进程组）发信号');
  }
  assert.equal(first.signal, 'SIGTERM');
});

test('停止会连带回收服务自己拉起的子进程（进程组信号）', async () => {
  // 父脚本再拉起一个长跑孙进程，并把孙进程 pid 打到 stdout
  const source = `
import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
process.stdout.write(String(grandchild.pid) + '\\n');
setInterval(() => {}, 1000);
`;
  await withScript(source, async ({ dir, script }) => {
    /** @type {number | null} */
    let grandchildPid = null;
    const handle = await startSupervisedProcess({
      id: 'test-group',
      command: process.execPath,
      args: [script],
      cwd: dir,
      onOutput: (stream, text) => {
        if (stream !== 'stdout') return;
        const parsed = Number.parseInt(text.trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) grandchildPid = parsed;
      },
    });

    // 等孙进程 pid 出现
    const deadline = Date.now() + 5000;
    while (grandchildPid === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(grandchildPid, '未能获取孙进程 pid，测试前提不成立');
    assert.equal(isProcessAlive(grandchildPid), true);

    try {
      const result = await stopSupervisedProcess(handle, {
        gracefulTimeoutMs: 300,
        killTimeoutMs: 3000,
      });
      assert.equal(result.stopped, true);
      assert.equal(
        isProcessAlive(grandchildPid),
        false,
        `孙进程 ${grandchildPid} 未被回收，说明没有对进程组发信号`,
      );
    } finally {
      forceKill(handle.pid);
      if (grandchildPid) forceKill(grandchildPid);
    }
  });
});

test('启动不存在的命令会以异常拒绝，而不是留下半死状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-kit-bad-'));
  try {
    await assert.rejects(
      startSupervisedProcess({
        id: 'bad',
        command: '/nonexistent/definitely-not-here',
        cwd: dir,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('参数校验：缺少必要字段直接抛 TypeError', async () => {
  await assert.rejects(
    // @ts-expect-error 故意缺 cwd
    startSupervisedProcess({ id: 'x', command: 'node' }),
    TypeError,
  );
  await assert.rejects(
    // @ts-expect-error 故意缺 command
    startSupervisedProcess({ id: 'x', cwd: '/tmp' }),
    TypeError,
  );
});
