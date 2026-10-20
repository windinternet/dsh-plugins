/**
 * 本地的工具定义编译器：替代 `@deepseek-ai/dsh-tools` 的 `defineTool`。
 *
 * **为什么要有这个文件。** 插件若把宿主内部包声明成普通依赖，pnpm 就会把它装进 profile 的
 * `node_modules`；而宿主按**包名**解析配置树里的行，profile 里的同名包会抢先命中、遮住宿主
 * 自带的那份。宿主升级后版本不再匹配，`tools` 行会被直接禁用，所有依赖工具服务的插件一起
 * 起不来（真实事故：`@deepseek-ai/dsh-tools@0.2.0-rc.2` 遮盖了宿主 0.2.1-rc.2）。
 *
 * 因此这里只实现插件真正用到的那一小部分契约，并**只产出宿主接受的 JSON Schema 子集**：
 * 单一 `type`、`properties`/`required`/布尔 `additionalProperties`、`items`、`enum`/`const`、
 * 以及作为"无约束 JSON"的注解型空 schema。宿主用 `assertSupportedJsonSchema` 校验输出 schema，
 * 越界的关键字会被拒绝，所以这里刻意只生成上述关键字。
 *
 * 与宿主的关系：`ctx.tools.register(definition)` 只要拿到
 * `{ name, description, parameters, output: { schema, render }, execute }` 就能工作；
 * 宿主**不会**替我们校验模型参数（那原本是 `defineTool` 包装做的），因此 `execute` 在
 * 这里被包一层参数校验。
 */

/** JSON Schema 子集支持的类型。 */
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** 允许出现在 schema 节点上的注解关键字。 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

/**
 * 判断一个值是不是普通对象（不接受数组与类实例）。
 *
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 把"作者写法"的属性表编译成宿主接受的 JSON Schema 对象。
 *
 * 作者写法与 JSON Schema 的唯一差别是：`required` 写在**属性级**（布尔），
 * 编译后提升为对象级的 `required: string[]`。
 *
 * @param {Record<string, any>} properties
 * @param {string} [path]
 * @returns {{ type: 'object', properties: Record<string, any>, required?: string[] }}
 */
export function compilePropertyMap(properties, path = 'parameters') {
  if (!isPlainObject(properties)) {
    throw new TypeError(`${path} 必须是对象（每个键一个参数声明）。`);
  }
  /** @type {Record<string, any>} */
  const compiled = {};
  /** @type {string[]} */
  const required = [];
  for (const [key, spec] of Object.entries(properties)) {
    if (!isPlainObject(spec)) {
      throw new TypeError(`${path}.${key} 必须是对象形式的 schema 声明。`);
    }
    if (spec.required === true) required.push(key);
    compiled[key] = compileNode(spec, `${path}.${key}`);
  }
  return {
    type: 'object',
    properties: compiled,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * 编译单个 schema 节点。
 *
 * @param {Record<string, any>} spec
 * @param {string} path
 * @returns {Record<string, any>}
 */
export function compileNode(spec, path) {
  if (!isPlainObject(spec)) throw new TypeError(`${path} 必须是对象形式的 schema 声明。`);

  /** @type {Record<string, any>} */
  const node = {};
  for (const key of ANNOTATION_KEYS) {
    if (spec[key] !== undefined) node[key] = spec[key];
  }

  // `json` 是作者写法里的"任意 JSON"。宿主把注解型空 schema 当作标准形式。
  if (spec.type === 'json') {
    if (spec.enum !== undefined) throw new TypeError(`${path} 是 json 类型，不能声明 enum。`);
    return node;
  }

  // 与宿主作者写法一致：oneOf 节点不带 type，且至少两个分支。
  if (spec.oneOf !== undefined) {
    if (spec.type !== undefined) throw new TypeError(`${path} 不能同时声明 type 与 oneOf。`);
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) {
      throw new TypeError(`${path}.oneOf 必须是至少两个分支的数组。`);
    }
    node.oneOf = spec.oneOf.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`));
    return node;
  }

  if (!SCHEMA_TYPES.has(spec.type)) {
    throw new TypeError(
      `${path}.type 必须是 ${[...SCHEMA_TYPES, 'json'].join(' / ')} 之一，实际是 ${String(spec.type)}。`,
    );
  }
  node.type = spec.type;

  if (spec.enum !== undefined || spec.const !== undefined) {
    // 宿主只接受标量节点上的 enum/const；对象与数组节点声明它们会被判为不支持。
    if (!['string', 'number', 'integer', 'boolean', 'null'].includes(spec.type)) {
      throw new TypeError(`${path} 只有标量类型可以声明 enum/const。`);
    }
    if (spec.enum !== undefined) {
      if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
        throw new TypeError(`${path}.enum 必须是非空数组。`);
      }
      node.enum = spec.enum;
    }
    if (spec.const !== undefined) node.const = spec.const;
  }

  if (spec.type === 'array') {
    if (spec.items === undefined) throw new TypeError(`${path} 是 array，必须声明 items。`);
    node.items = compileNode(spec.items, `${path}.items`);
  }

  if (spec.type === 'object') {
    if (spec.properties !== undefined) {
      const nested = compilePropertyMap(spec.properties, `${path}.properties`);
      node.properties = nested.properties;
      if (nested.required !== undefined) node.required = nested.required;
    }
    if (typeof spec.additionalProperties === 'boolean') {
      node.additionalProperties = spec.additionalProperties;
    }
  }

  return node;
}

/**
 * 校验一次调用的参数。返回违规描述（空数组表示通过）。
 *
 * 刻意不用完整 JSON Schema 校验器：作者写法本身就是受约束的，逐条判断更短、错误信息更准。
 *
 * @param {Record<string, any>} properties
 * @param {unknown} args
 * @param {string} [path]
 * @returns {string[]}
 */
export function validateArgs(properties, args, path = '') {
  /** @type {string[]} */
  const violations = [];
  if (!isPlainObject(args)) {
    violations.push(`${path || '参数'} 必须是对象。`);
    return violations;
  }
  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];
    const valuePath = path === '' ? key : `${path}.${key}`;
    if (value === undefined) {
      if (spec.required === true) violations.push(`${valuePath} 是必填参数。`);
      continue;
    }
    violations.push(...validateValue(spec, value, valuePath));
  }
  return violations;
}

/**
 * 校验一个值是否符合某个作者写法节点。
 *
 * @param {Record<string, any>} spec
 * @param {unknown} value
 * @param {string} path
 * @returns {string[]}
 */
export function validateValue(spec, value, path) {
  /** @type {string[]} */
  const violations = [];

  if (spec.type === 'json') return violations;

  if (spec.type === 'oneOf') {
    const matches = (spec.oneOf ?? []).filter(
      (/** @type {any} */ branch) => validateValue(branch, value, path).length === 0,
    );
    if (matches.length !== 1) violations.push(`${path} 必须恰好匹配 oneOf 的一个分支。`);
    return violations;
  }

  if (
    spec.enum !== undefined &&
    !spec.enum.some((/** @type {unknown} */ allowed) => sameJson(allowed, value))
  ) {
    violations.push(
      `${path} 必须是 ${spec.enum
        .map((/** @type {unknown} */ item) => JSON.stringify(item))
        .join(' / ')} 之一。`,
    );
    return violations;
  }

  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${path} 必须是字符串。`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        violations.push(`${path} 必须是有限数字。`);
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        violations.push(`${path} 必须是整数。`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${path} 必须是布尔值。`);
      break;
    case 'null':
      if (value !== null) violations.push(`${path} 必须是 null。`);
      break;
    case 'array':
      if (!Array.isArray(value)) {
        violations.push(`${path} 必须是数组。`);
        break;
      }
      if (spec.items !== undefined) {
        value.forEach((item, index) => {
          violations.push(...validateValue(spec.items, item, `${path}[${index}]`));
        });
      }
      break;
    case 'object': {
      if (!isPlainObject(value)) {
        violations.push(`${path} 必须是对象。`);
        break;
      }
      const properties = spec.properties ?? {};
      violations.push(...validateArgs(properties, value, path));
      if (spec.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) violations.push(`${path}.${key} 不是已声明的字段。`);
        }
      }
      break;
    }
    default:
      violations.push(`${path} 的 schema 类型不受支持：${String(spec.type)}。`);
  }
  return violations;
}

/**
 * 判断两个 JSON 值是否相等（用于 enum 匹配）。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * 定义并校验一个工具。
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {Record<string, any>} [options.parameters]
 * @param {{ schema: any, render: (args: any, value: any) => { type: 'text', text: string }[] }} options.output
 * @param {(args: any, exec: any) => Promise<any>} options.execute
 * @param {number} [options.timeoutMs]
 * @param {(args: any) => boolean} [options.isConcurrencySafe]
 * @param {boolean} [options.deferLoading]
 * @returns {any} 可直接交给 ctx.tools.register 的定义
 */
export function defineTool(options) {
  if (!isPlainObject(options)) throw new TypeError('defineTool(options) 需要一个对象。');
  const { name, description, parameters, output, execute } = options;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('defineTool 需要非空的 name。');
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new TypeError(`工具 ${name} 需要非空的 description。`);
  }
  if (!isPlainObject(output) || typeof output.render !== 'function') {
    throw new TypeError(`工具 ${name} 必须声明 output { schema, render }。`);
  }
  if (typeof execute !== 'function') throw new TypeError(`工具 ${name} 需要 execute 函数。`);

  const properties = parameters ?? {};
  const compiledParameters = compilePropertyMap(properties, `${name}.parameters`);
  const compiledOutput = compileNode(output.schema, `${name}.output.schema`);

  return {
    name,
    description,
    parameters: compiledParameters,
    output: {
      schema: compiledOutput,
      render: output.render,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.isConcurrencySafe === undefined
      ? {}
      : { isConcurrencySafe: options.isConcurrencySafe }),
    ...(options.deferLoading === true ? { deferLoading: true } : {}),
    /**
     * 校验参数后再调用真实执行体。
     *
     * @param {any} args
     * @param {any} exec
     * @returns {Promise<any>}
     */
    async execute(args, exec) {
      const violations = validateArgs(properties, args);
      if (violations.length > 0) {
        const error = new TypeError(`invalid arguments: ${violations.join('; ')}`);
        error.name = 'ToolArgsError';
        throw error;
      }
      return execute(args, exec);
    },
  };
}
