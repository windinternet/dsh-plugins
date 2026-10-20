import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';

/**
 * 配置归一化的目标不是"严格校验"，而是**永远给出一份可用的配置**：
 * 用户写错一个字段不该让插件无法激活，只该降级并留一条能看懂诊断。
 */

/** @type {Record<string, import('../src/config.js').ConfigField>} */
const SPEC = {
  dataDir: { type: 'string' },
  port: { type: 'number', default: 24000 },
  headless: { type: 'boolean', default: true },
  mode: { type: 'string', default: 'new', values: ['new', 'old'] },
  args: { type: 'array', default: [] },
  anything: { type: 'any', default: [1, 2] },
};

test('normalizeConfig：缺省输入得到完整默认值', () => {
  assert.deepEqual(normalizeConfig(SPEC, undefined), {
    dataDir: undefined,
    port: 24000,
    headless: true,
    mode: 'new',
    args: [],
    anything: [1, 2],
  });
  assert.deepEqual(normalizeConfig(SPEC, null), normalizeConfig(SPEC, undefined));
});

test('normalizeConfig：合法输入覆盖默认值', () => {
  const config = normalizeConfig(SPEC, {
    dataDir: '/tmp/x',
    port: 25000,
    headless: false,
    mode: 'old',
    args: ['--lang=zh-CN'],
    anything: 'anything goes',
  });
  assert.equal(config.dataDir, '/tmp/x');
  assert.equal(config.port, 25000);
  assert.equal(config.headless, false);
  assert.equal(config.mode, 'old');
  assert.deepEqual(config.args, ['--lang=zh-CN']);
  assert.equal(config.anything, 'anything goes');
});

test('normalizeConfig：类型不符回退默认值，并说明原因', () => {
  /** @type {string[]} */
  const problems = [];
  const config = normalizeConfig(SPEC, { port: '25000', headless: 'yes' }, (m) => problems.push(m));
  assert.equal(config.port, 24000);
  assert.equal(config.headless, true);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /port 应为 number/);
  assert.match(problems.join('\n'), /headless 应为 boolean/);
});

test('normalizeConfig：枚举越界回退默认值', () => {
  /** @type {string[]} */
  const problems = [];
  const config = normalizeConfig(SPEC, { mode: 'sideways' }, (m) => problems.push(m));
  assert.equal(config.mode, 'new');
  assert.match(problems.join('\n'), /不在允许范围/);
});

test('normalizeConfig：未知字段忽略并给出可操作提示', () => {
  /** @type {string[]} */
  const problems = [];
  const config = normalizeConfig(SPEC, { prot: 1 }, (m) => problems.push(m));
  assert.equal(config.prot, undefined);
  assert.match(problems.join('\n'), /未知配置项 prot/);
  // 提示里要列出可用项，用户才知道正确拼写
  assert.match(problems.join('\n'), /port/);
});

test('normalizeConfig：非对象输入整体拒绝，仍返回默认值', () => {
  /** @type {string[]} */
  const problems = [];
  const config = normalizeConfig(SPEC, ['nope'], (m) => problems.push(m));
  assert.equal(config.port, 24000);
  assert.match(problems.join('\n'), /config 必须是对象/);
});

test('normalizeConfig：数组默认值不被共享引用污染', () => {
  const first = normalizeConfig(SPEC, undefined);
  first.args.push('mutated');
  const second = normalizeConfig(SPEC, undefined);
  assert.deepEqual(second.args, []);
});
