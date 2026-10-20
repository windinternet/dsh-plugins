import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileNode,
  compilePropertyMap,
  defineTool,
  validateArgs,
} from '../src/tool-definition.js';

/**
 * 这个模块替代宿主自带的 `defineTool`，因此测试要盯住两件事：
 * 1. 产出的 schema 必须落在宿主接受的 JSON Schema 子集里（属性级 required 要提升为数组）；
 * 2. 参数校验必须真的拦住非法调用——宿主注册表不会替我们校验。
 */

test('compilePropertyMap：属性级 required 提升为对象级 required 数组', () => {
  const schema = compilePropertyMap({
    query: { type: 'string', required: true, description: '查询' },
    limit: { type: 'integer', default: 10 },
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查询' },
      limit: { type: 'integer', default: 10 },
    },
    required: ['query'],
  });
});

test('compileNode：json 编译成注解型空 schema（宿主认可的无约束形式）', () => {
  assert.deepEqual(compileNode({ type: 'json', description: '任意值' }, 'v'), {
    description: '任意值',
  });
});

test('compileNode：嵌套 object / array 与 additionalProperties', () => {
  const schema = compileNode(
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string', required: true } },
          },
        },
      },
    },
    'out',
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.items.type, 'array');
  assert.deepEqual(schema.properties.items.items.required, ['id']);
});

test('compileNode：oneOf 与 enum 保留为宿主支持的约束', () => {
  const oneOf = compileNode({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 'x');
  assert.equal(oneOf.oneOf.length, 2);
  // 与宿主一致：oneOf 节点不能同时带 type，且至少两个分支
  assert.throws(
    () => compileNode({ type: 'string', oneOf: [{ type: 'string' }] }, 'x'),
    /不能同时/,
  );
  assert.throws(() => compileNode({ oneOf: [{ type: 'string' }] }, 'x'), /至少两个/);
  // 非标量节点不允许 enum
  assert.throws(() => compileNode({ type: 'object', enum: [{}] }, 'x'), /标量/);
  const enumNode = compileNode({ type: 'string', enum: ['a', 'b'] }, 'y');
  assert.deepEqual(enumNode, { type: 'string', enum: ['a', 'b'] });
});

test('compileNode：未知类型与缺失 items 明确报错，而不是产出坏 schema', () => {
  assert.throws(() => compileNode({ type: 'map' }, 'x'), /type 必须是/);
  assert.throws(() => compileNode({ type: 'array' }, 'x'), /必须声明 items/);
  assert.throws(() => compileNode({ type: 'object', properties: [] }, 'x'), /必须是对象/);
});

test('defineTool：缺 render / 缺 execute / 缺 name 都当场失败', () => {
  /** @type {any} */
  const base = {
    name: 'probe',
    description: '测试',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '' }] },
    execute: async () => 'ok',
  };
  assert.throws(() => defineTool({ ...base, output: { schema: { type: 'string' } } }), /render/);
  assert.throws(() => defineTool({ ...base, execute: undefined }), /execute/);
  assert.throws(() => defineTool({ ...base, name: '' }), /name/);
  assert.throws(() => defineTool({ ...base, description: '' }), /description/);
});

test('defineTool：输出是宿主可直接接受的形状', async () => {
  const tool = defineTool({
    name: 'probe',
    description: '测试',
    parameters: { a: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    },
    timeoutMs: 1234,
    isConcurrencySafe: () => true,
    async execute(args) {
      return { ok: args.a === 'yes' };
    },
  });
  assert.equal(tool.name, 'probe');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['a']);
  assert.equal(tool.output.schema.type, 'object');
  assert.equal(tool.timeoutMs, 1234);
  assert.equal(tool.isConcurrencySafe(), true);
  assert.deepEqual(await tool.execute({ a: 'yes' }, {}), { ok: true });
});

test('defineTool：缺少必填参数时拒绝执行（宿主不会替我们校验）', async () => {
  const tool = defineTool({
    name: 'probe',
    description: '测试',
    parameters: { a: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '' }] },
    async execute() {
      return 'should not run';
    },
  });
  await assert.rejects(
    () => tool.execute({}, {}),
    (/** @type {any} */ error) => {
      assert.equal(error.name, 'ToolArgsError');
      assert.match(error.message, /a 是必填参数/);
      return true;
    },
  );
});

test('defineTool：类型不符也在执行前被拒绝', async () => {
  const tool = defineTool({
    name: 'probe',
    description: '测试',
    parameters: { n: { type: 'integer', required: true } },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '' }] },
    async execute() {
      return 'should not run';
    },
  });
  await assert.rejects(() => tool.execute({ n: 1.5 }, {}), /整数/);
});

test('validateArgs：nil 与额外字段的处理', () => {
  // 参数根不声明 additionalProperties，因此额外字段放行（模型偶尔会多给字段）
  assert.deepEqual(validateArgs({ a: { type: 'string' } }, { a: 'x', extra: 1 }), []);
  // 嵌套对象声明 additionalProperties:false 时，多给字段会被点名
  const violations = validateArgs(
    {
      box: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } },
    },
    { box: { id: 'x', other: true } },
  );
  assert.equal(violations.length, 1);
  assert.match(String(violations[0]), /box\.other/);
});

test('validateArgs：非对象参数直接报错，不抛异常', () => {
  assert.deepEqual(validateArgs({}, null), ['参数 必须是对象。']);
  assert.deepEqual(validateArgs({}, 'x'), ['参数 必须是对象。']);
});
