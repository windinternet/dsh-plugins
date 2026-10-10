/**
 * 日志环形缓冲与落盘。
 *
 * 为什么需要环形缓冲：被托管的服务可能连续输出很久。如果只把输出堆在内存里，
 * 一个啰嗦的服务会慢慢吃掉宿主进程的内存；如果只写文件，面板就读不到"最近的输出"。
 * 所以要两者都有：内存里保留最近若干行供面板展示，文件里保留完整记录供排查，
 * 文件超过上限后轮转，避免长跑把磁盘写满。
 *
 * 边界约束：进程输出是不可信数据。所有进入缓冲的文本在写入前都会经过脱敏，
 * 因为服务在启动日志里打印一次自己的配置（含密钥）是极常见的做法。
 */

import { appendFile, mkdir, rename, stat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactString } from './redact.js';

/**
 * @typedef {object} LogEntry
 * @property {'stdout'|'stderr'|'system'} stream 输出来源
 * @property {number} at 时间戳（毫秒）
 * @property {string} text 文本（已脱敏，可能含多行）
 */

/**
 * @typedef {object} LogBufferOptions
 * @property {number} [maxEntries] 内存里保留的最大行数
 * @property {number} [maxEntryLength] 单行的最大长度，超出部分截断
 * @property {number} [maxBytes] 日志文件的上限字节数，超出后轮转
 * @property {string} [file] 日志文件路径；不提供则只保留内存缓冲
 * @property {string} [homeDir] 家目录，用于脱敏
 * @property {number} [maxRotations] 保留的历史文件份数
 */

/**
 * 环形日志缓冲。
 *
 * 用法：
 * ```js
 * const buffer = new LogBuffer({ file: '/path/app.log', maxEntries: 500 });
 * buffer.append('stdout', 'server listening');
 * const recent = buffer.tail(50);
 * ```
 */
export class LogBuffer {
  /**
   * @param {LogBufferOptions} [options]
   */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.maxEntryLength = options.maxEntryLength ?? 8192;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxRotations = options.maxRotations ?? 3;
    this.file = options.file;
    this.homeDir = options.homeDir;
    /** @type {LogEntry[]} */
    this.entries = [];
    this.writtenBytes = 0;
    /** @type {Promise<void>} 串行化写盘，避免并发 append 交错 */
    this.writeChain = Promise.resolve();
  }

  /**
   * 追加一条输出。文本会先按行拆分再逐行脱敏入缓冲。
   *
   * @param {'stdout'|'stderr'|'system'} stream
   * @param {string} text
   */
  append(stream, text) {
    if (typeof text !== 'string' || text.length === 0) return;
    const now = Date.now();
    // 保留换行语义：按行切分，但记下是否有末尾换行，避免把两次输出粘成一行
    const lines = text.split('\n');
    const endsWithNewline = lines[lines.length - 1] === '';
    if (endsWithNewline) lines.pop();

    for (const rawLine of lines) {
      const redacted = redactString(rawLine, { homeDir: this.homeDir });
      const clipped =
        redacted.length > this.maxEntryLength
          ? `${redacted.slice(0, this.maxEntryLength)}…[已截断 ${redacted.length - this.maxEntryLength} 字符]`
          : redacted;
      this.entries.push({ stream, at: now, text: clipped });
    }
    if (lines.length === 0 && !endsWithNewline) return;

    while (this.entries.length > this.maxEntries) this.entries.shift();

    if (this.file) {
      const payload = lines.map((line) => redactString(line, { homeDir: this.homeDir })).join('\n');
      const chunk = `${payload}${endsWithNewline ? '\n' : ''}`;
      this.writeChain = this.writeChain.then(() => this.#write(chunk)).catch(() => {});
    }
  }

  /**
   * 读取最近若干行。
   * @param {number} [count]
   * @returns {LogEntry[]}
   */
  tail(count = 100) {
    if (count <= 0) return [];
    return this.entries.slice(-count);
  }

  /** 只清空内存缓冲，不动文件。用于面板主动释放内存。 */
  clear() {
    this.entries = [];
  }

  /**
   * 等待所有挂起的写盘完成。测试与插件卸载前应当调用它。
   * @returns {Promise<void>}
   */
  async flush() {
    await this.writeChain;
  }

  /**
   * @param {string} chunk
   */
  async #write(chunk) {
    const file = this.file;
    if (!file) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      await this.#rotateIfNeeded(Buffer.byteLength(chunk, 'utf8'));
      await appendFile(file, chunk, 'utf8');
      this.writtenBytes += Buffer.byteLength(chunk, 'utf8');
    } catch {
      // 日志写失败不应让被托管的服务崩溃；信息已在内存缓冲里可见。
    }
  }

  /**
   * @param {number} incoming
   */
  async #rotateIfNeeded(incoming) {
    const file = this.file;
    if (!file) return;
    if (this.writtenBytes === 0) {
      try {
        const info = await stat(file);
        this.writtenBytes = info.size;
      } catch {
        this.writtenBytes = 0;
      }
    }
    if (this.writtenBytes + incoming <= this.maxBytes) return;

    // 轮转：app.log -> app.log.1 -> app.log.2 ...，最老的丢弃
    for (let i = this.maxRotations - 1; i >= 1; i -= 1) {
      try {
        await rename(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        // 该份不存在，跳过
      }
    }
    try {
      await rename(file, `${file}.1`);
    } catch {
      // 目标不存在，说明还没写过
    }
    this.writtenBytes = 0;
  }
}

/**
 * 读取一个日志文件的尾部若干行，不加载整个文件。
 *
 * 实现方式是从文件末尾反向读取固定大小的块。这样即使日志有几百 MB，
 * 读取尾部也只需要一次或几次读操作，而不是把整个文件读进内存。
 *
 * @param {string} file
 * @param {{ lines?: number, maxBytes?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function readTail(file, options = {}) {
  const wantLines = options.lines ?? 100;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  if (wantLines <= 0) return [];

  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return [];
  }

  try {
    const info = await handle.stat();
    const size = info.size;
    if (size === 0) return [];

    const chunkSize = 64 * 1024;
    /** @type {string[]} */
    const collected = [];
    let position = size;
    let carry = '';
    let readBytes = 0;

    while (position > 0 && collected.length <= wantLines && readBytes < maxBytes) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, position);
      readBytes += length;

      const text = buffer.toString('utf8') + carry;
      const parts = text.split('\n');
      carry = parts.shift() ?? '';
      // 逆序塞入，保持整体顺序正确
      for (const part of parts.slice().reverse()) collected.unshift(part);
    }

    if (carry !== '' && position === 0) collected.unshift(carry);

    // 去掉末尾因文件以换行结尾而产生的空项
    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
    return collected.slice(-wantLines);
  } finally {
    await handle.close();
  }
}
