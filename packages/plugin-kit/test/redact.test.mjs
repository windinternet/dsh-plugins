import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString, redactValue, containsSecret } from '../src/redact.js';

test('抹掉 OpenAI 风格密钥', () => {
  const out = redactString('正在加载 sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 完成'); // secret-scan:allow: 脱敏用例的输入，必须形似真实密钥才能验证规则命中
  assert.equal(out, '正在加载 <redacted:openai-key> 完成');
});

test('抹掉 URL 内嵌凭据但保留用户名与主机', () => {
  const out = redactString('连接 postgres://admin:s3cr3tpassword@db.internal:5432/app'); // secret-scan:allow: 脱敏用例的输入，必须形似真实凭据才能验证覆盖
  assert.match(out, /postgres:\/\/admin:<redacted:password>@db\.internal/);
  assert.ok(!out.includes('s3cr3tpassword'));
});

test('抹掉 .env 风格赋值中的真实值', () => {
  const out = redactString('SOME_API_KEY=abcdef1234567890');
  assert.equal(out, 'SOME_API_KEY=<redacted:value>');
});

test('保留 .env 风格赋值中的占位符', () => {
  const cases = [
    'SOME_API_KEY=your-api-key-here',
    'SOME_API_KEY=${MY_KEY}',
    'SOME_API_KEY=xxxxxxxxxxxx',
  ];
  for (const input of cases) {
    assert.equal(redactString(input), input, `不应抹掉占位符：${input}`);
  }
});

test('抹掉 Authorization 头', () => {
  const out = redactString('Authorization: Bearer abcdefghijklmnop');
  assert.match(out, /^Authorization: <redacted:/);
});

test('把家目录抹成 ~', () => {
  const out = redactString('/Users/alice/projects/app', { homeDir: '/Users/alice' });
  assert.equal(out, '~/projects/app');
});

test('未提供家目录时仍抹掉常见家目录形态', () => {
  const out = redactString('cwd=/Users/bob/app');
  assert.ok(!out.includes('bob'), `不应包含用户名：${out}`);
});

test('extraPaths 会被整体替换', () => {
  const out = redactString('/opt/internal/repo/src/a.js', { extraPaths: ['/opt/internal'] });
  assert.equal(out, '<redacted:path>/repo/src/a.js');
});

test('keepLength 用等长星号替换', () => {
  const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'; // secret-scan:allow: 脱敏用例的输入，必须形似真实密钥才能验证等长替换
  const out = redactString(secret, { keepLength: true });
  assert.equal(out.length, secret.length);
  assert.match(out, /^\*+$/);
});

test('redactValue 递归处理对象与数组', () => {
  /** @type {Record<string, unknown>} */
  const input = {
    token: 'ghp_' + 'A'.repeat(40),
    nested: ['Authorization: Bearer xyzxyzxyzxyzxyzxyz'],
  };
  const out = /** @type {Record<string, unknown>} */ (redactValue(input));
  assert.equal(out.token, '<redacted:github-token>');
  assert.ok(!JSON.stringify(out).includes('xyzxyz'), `嵌套值未被脱敏：${JSON.stringify(out)}`);
});

test('redactValue 在超深结构上截断而不是无限递归', () => {
  /** @type {Record<string, unknown>} */
  let deep = { value: 'ok' };
  for (let i = 0; i < 30; i += 1) deep = { child: deep };
  const out = redactValue(deep);
  assert.ok(JSON.stringify(out).includes('too-deep'));
});

test('containsSecret 能识别密钥，且不误报占位符', () => {
  assert.equal(containsSecret('key = sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ01'), true); // secret-scan:allow: containsSecret 用例的输入，必须形似真实密钥才能验证识别
  assert.equal(containsSecret('普通日志，没有敏感内容'), false);
  assert.equal(containsSecret('SOME_API_KEY=your-api-key-here'), false);
});

test('非字符串输入原样返回', () => {
  assert.equal(redactString(''), '');
  // @ts-expect-error 故意传入非法类型，验证运行时防御
  assert.equal(redactString(null), null);
});
