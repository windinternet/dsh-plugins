import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogBuffer, readTail } from '../src/log-buffer.js';

/**
 * 取缓冲里的最后一条日志并断言其存在。
 * @param {LogBuffer} buffer
 * @returns {import('../src/log-buffer.js').LogEntry}
 */
function lastEntry(buffer) {
  const entries = buffer.tail(1);
  const entry = entries[0];
  assert.ok(entry, '期望缓冲里至少有一条日志');
  return /** @type {import('../src/log-buffer.js').LogEntry} */ (entry);
}

test('内存缓冲保留最近 maxEntries 行', () => {
  const buffer = new LogBuffer({ maxEntries: 3 });
  for (let i = 1; i <= 5; i += 1) buffer.append('stdout', `第 ${i} 行`);
  assert.deepEqual(
    buffer.tail(10).map((e) => e.text),
    ['第 3 行', '第 4 行', '第 5 行'],
  );
});

test('区分 stdout 与 stderr', () => {
  const buffer = new LogBuffer();
  buffer.append('stdout', '正常输出');
  buffer.append('stderr', '错误输出');
  assert.deepEqual(
    buffer.tail(2).map((e) => e.stream),
    ['stdout', 'stderr'],
  );
});

test('写入缓冲前先脱敏', () => {
  const buffer = new LogBuffer();
  buffer.append('stdout', '启动中，token=ghp_' + 'A'.repeat(40));
  const text = lastEntry(buffer).text;
  assert.ok(!text.includes('A'.repeat(40)), `密钥未被抹掉：${text}`);
  assert.match(text, /redacted/);
});

test('超长单行被截断并标注', () => {
  const buffer = new LogBuffer({ maxEntryLength: 20 });
  buffer.append('stdout', 'x'.repeat(100));
  const text = lastEntry(buffer).text;
  assert.ok(text.startsWith('x'.repeat(20)));
  assert.match(text, /已截断 80 字符/);
});

test('多行输出被拆成多条并保留换行语义', () => {
  const buffer = new LogBuffer();
  buffer.append('stdout', 'a\nb\nc');
  assert.deepEqual(
    buffer.tail(10).map((e) => e.text),
    ['a', 'b', 'c'],
  );
  buffer.clear();
  buffer.append('stdout', 'a\nb\n');
  assert.deepEqual(
    buffer.tail(10).map((e) => e.text),
    ['a', 'b'],
  );
});

test('空字符串与非字符串输入被忽略', () => {
  const buffer = new LogBuffer();
  buffer.append('stdout', '');
  // @ts-expect-error 故意传入非法类型，验证运行时防御
  buffer.append('stdout', null);
  assert.equal(buffer.tail(10).length, 0);
});

test('落盘：内容写入文件且并发追加不交错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-kit-log-'));
  const file = join(dir, 'app.log');
  try {
    const buffer = new LogBuffer({ file });
    for (let i = 0; i < 50; i += 1) buffer.append('stdout', `行 ${i}\n`);
    await buffer.flush();
    const content = await readFile(file, 'utf8');
    assert.equal(content.split('\n').filter(Boolean).length, 50);
    // 顺序必须保持一致
    assert.equal(content.split('\n')[0], '行 0');
    assert.equal(content.split('\n')[49], '行 49');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件超过上限后轮转，历史文件被保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-kit-rotate-'));
  const file = join(dir, 'app.log');
  try {
    const buffer = new LogBuffer({ file, maxBytes: 200, maxRotations: 2 });
    for (let i = 0; i < 40; i += 1) buffer.append('stdout', `这是一行足够长的日志内容 ${i}\n`);
    await buffer.flush();

    const current = await stat(file);
    assert.ok(current.size <= 200 * 2, `当前文件应受上限约束，实际 ${current.size}`);
    // 至少产生过一次轮转
    const rotated = await stat(`${file}.1`);
    assert.ok(rotated.size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readTail 从文件尾部读取指定行数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-kit-tail-'));
  const file = join(dir, 'app.log');
  try {
    const lines = Array.from({ length: 100 }, (_, i) => `行 ${i}`);
    await writeFile(file, `${lines.join('\n')}\n`);
    const tail = await readTail(file, { lines: 5 });
    assert.deepEqual(tail, ['行 95', '行 96', '行 97', '行 98', '行 99']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readTail 在文件不存在或为空时返回空数组', async () => {
  assert.deepEqual(await readTail('/nonexistent/path/app.log'), []);
  const dir = await mkdtemp(join(tmpdir(), 'plugin-kit-tail2-'));
  try {
    const file = join(dir, 'empty.log');
    await writeFile(file, '');
    assert.deepEqual(await readTail(file), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readTail 处理没有末尾换行的文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-kit-tail3-'));
  const file = join(dir, 'app.log');
  try {
    await writeFile(file, 'a\nb\nc');
    const tail = await readTail(file, { lines: 2 });
    assert.deepEqual(tail, ['b', 'c']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
