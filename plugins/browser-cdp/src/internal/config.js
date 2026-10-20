/**
 * 本文件是 packages/plugin-kit/src/config.js 的同步副本。
 *
 * 为什么要复制而不是直接 import：本仓库的插件必须能独立安装到任意 DSH profile。
 * 这里同样适用于"宿主内部包"——**插件绝不能把宿主自有包声明成依赖**，否则 pnpm 会把它
 * 装进 profile 并遮住宿主自带的那份，宿主一升级就触发精确版本校验失败、整条工具链被禁用。
 *
 * 因此这三个小工具以同步副本形式随插件分发：单一消费者时复制比引入发布流程简单得多。
 * 改动要两边一起改（本文件与 packages/plugin-kit/src/config.js），再跑 `pnpm check`。
 */
/**
 * 本地配置归一化：替代 `@deepseek-ai/schemastery` 的 `Config`。
 *
 * **为什么不导出 `Config`。** 宿主的 `Config` 必须是 schemastery 的 `Schema` 实例；
 * 而 schemastery 随宿主分发，插件若把它声明成依赖，就会在 profile 里装出第二份宿主包，
 * 遮住宿主自带的版本——宿主升级后触发精确版本校验失败，整条工具链被禁用。
 * 配置校验本身不是插件激活的必要条件，因此这里用一份极小的规格表自行归一化：
 * 类型不符或取值越界时回退到默认值并记一条诊断，而不是让插件无法启动。
 *
 * 规格表只表达"默认值 + 类型"，足够覆盖本仓库插件的配置面；需要枚举时用 `values`。
 */

/**
 * @typedef {object} ConfigField
 * @property {'string' | 'number' | 'boolean' | 'array' | 'any'} type
 * @property {unknown} [default]
 * @property {unknown[]} [values] 允许的取值（枚举）。
 */

/**
 * 按规格表归一化配置。
 *
 * @param {Record<string, ConfigField>} spec
 * @param {unknown} input 来自 profile patch 的原始 config
 * @param {(message: string) => void} [onProblem] 诊断回调
 * @returns {Record<string, any>} 每个字段都有值的新对象
 */
export function normalizeConfig(spec, input, onProblem) {
  /** @param {string} message */
  const problem = (message) => {
    if (typeof onProblem === 'function') onProblem(message);
  };

  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, field] of Object.entries(spec)) {
    out[key] = cloneDefault(field.default);
  }

  if (input === undefined || input === null) return out;
  if (typeof input !== 'object' || Array.isArray(input)) {
    problem(
      `config 必须是对象，实际是 ${Array.isArray(input) ? 'array' : typeof input}；已忽略并使用默认值。`,
    );
    return out;
  }

  for (const [key, raw] of Object.entries(input)) {
    const field = spec[key];
    if (field === undefined) {
      problem(`未知配置项 ${key}，已忽略（可用项：${Object.keys(spec).join('、')}）。`);
      continue;
    }
    if (!matchesType(field.type, raw)) {
      problem(`配置项 ${key} 应为 ${field.type}，实际是 ${describe(raw)}；已回退到默认值。`);
      continue;
    }
    if (Array.isArray(field.values) && !field.values.some((allowed) => allowed === raw)) {
      problem(
        `配置项 ${key} 取值 ${JSON.stringify(raw)} 不在允许范围内（${field.values
          .map((value) => JSON.stringify(value))
          .join('、')}）；已回退到默认值。`,
      );
      continue;
    }
    out[key] = raw;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneDefault(value) {
  if (Array.isArray(value)) return value.map((item) => cloneDefault(item));
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneDefault(item);
    return copy;
  }
  return value;
}

/**
 * @param {ConfigField['type']} type
 * @param {unknown} value
 * @returns {boolean}
 */
function matchesType(type, value) {
  switch (type) {
    case 'any':
      return true;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}
