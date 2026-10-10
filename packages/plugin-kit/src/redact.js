/**
 * 脱敏：把可能敏感的片段从即将写入日志或回灌给模型的内容里抹掉。
 *
 * 为什么需要它：插件会读进程输出、用户配置文件、第三方响应，这些内容是不可信的，
 * 而且经常意外包含密钥。DSH 的约束是"显示前脱敏敏感信息"，这里是那条约束的落点。
 *
 * 设计取舍：
 * - 保守优先：宁可多抹一点，也不要漏。误抹只损失可读性，漏抹会泄露凭据。
 * - 保持结构：把密钥替换成 `<redacted:类型>`，而不是整行删掉，否则日志失去诊断价值。
 * - 不追求完备：正则识别不了分段拼接或编码后的密钥。这是纵深防御的一层，不是唯一一层。
 */

/**
 * @typedef {object} RedactOptions
 * @property {boolean} [keepLength] 是否保留原长度（用等长星号替换）。默认 false，更易读。
 * @property {string[]} [extraPaths] 额外需要抹掉的本机路径前缀，例如用户家目录。
 * @property {string} [homeDir] 家目录；提供时会把其中的用户名部分抹成 `~`。
 */

/**
 * @typedef {object} SecretPattern
 * @property {string} name 类型名，出现在替换结果里，便于诊断"抹掉了什么"。
 * @property {RegExp} pattern 匹配规则。
 */

/**
 * 高置信度敏感片段。顺序有意义：长的、更具体的模式要排在前面，
 * 否则会被较短的模式先吃掉一部分，得到难读的结果。
 * @type {SecretPattern[]}
 */
const SECRET_PATTERNS = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  {
    name: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  { name: 'aws-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // URL 内嵌凭据：postgres://user:pass@host 这类，密码段必须抹掉
  { name: 'url-credentials', pattern: /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/:@]+@/gi },
  // .env 风格赋值：KEY=value。只抹看起来像真实值的，占位符保留。
  {
    name: 'env-assignment',
    pattern:
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(["']?)([^\s"']{8,})\2/g,
  },
  // 常见密钥请求头
  {
    name: 'auth-header',
    pattern: /\b(authorization|api[-_]?key|x-api-key)\s*:\s*(?:bearer\s+|basic\s+)?[^\s,;]{8,}/gi,
  },
];

/** 明显是占位符或示例的值，不该被当成密钥抹掉。 */
const PLACEHOLDER_VALUE =
  /^(?:x+|\*+|\.+|<[^>]*>|\$\{?[A-Za-z0-9_]+\}?|your[-_].*|changeme|placeholder|example|dummy|fake|todo|none|null|undefined|redacted)$/i;

/**
 * 判断一个值是否应被视为占位符。
 * @param {string} value
 * @returns {boolean}
 */
function isPlaceholder(value) {
  if (PLACEHOLDER_VALUE.test(value)) return true;
  if (/^(.)\1+$/.test(value)) return true; // 全是同一个字符
  return false;
}

/**
 * 构造替换文本。
 * @param {string} name
 * @param {string} original
 * @param {RedactOptions} options
 * @returns {string}
 */
function replacement(name, original, options) {
  if (options.keepLength) return '*'.repeat(Math.max(3, original.length));
  return `<redacted:${name}>`;
}

/**
 * 对一个字符串做脱敏。
 *
 * @param {string} input
 * @param {RedactOptions} [options]
 * @returns {string}
 */
export function redactString(input, options = {}) {
  if (typeof input !== 'string' || input.length === 0) return input;

  let out = input;

  for (const { name, pattern } of SECRET_PATTERNS) {
    // 每次重新构造正则，避免 lastIndex 在多次调用间串味
    const re = new RegExp(pattern.source, pattern.flags);
    out = out.replace(re, (match, ...groups) => {
      // url-credentials 与 env-assignment 的第一个捕获组是需要保留的前缀
      if (name === 'url-credentials') {
        return `${groups[0]}:${replacement('password', match, options)}@`;
      }
      if (name === 'env-assignment') {
        const key = groups[0];
        const value = groups[2];
        if (typeof value !== 'string' || isPlaceholder(value)) return match;
        return `${key}=${replacement('value', value, options)}`;
      }
      if (name === 'auth-header') {
        const header = groups[0];
        return `${header}: ${replacement('token', match, options)}`;
      }
      return replacement(name, match, options);
    });
  }

  // 家目录路径：把用户名抹成 ~，避免把个人身份带进日志与模型上下文
  if (options.homeDir && typeof options.homeDir === 'string' && options.homeDir.length > 1) {
    const escaped = options.homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '~');
  } else {
    // 未提供家目录时，仍抹掉类 Unix 与 Windows 的常见家目录形态
    out = out.replace(/\/(?:Users|home)\/([^/\s"']+)/g, (match, user) =>
      isPlaceholder(user) ? match : replacement('home', match, options),
    );
    out = out.replace(/[A-Za-z]:\\Users\\([^\\\s"']+)/g, (match, user) =>
      isPlaceholder(user) ? match : replacement('home', match, options),
    );
  }

  for (const extra of options.extraPaths ?? []) {
    if (typeof extra !== 'string' || extra.length < 3) continue;
    const escaped = extra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '<redacted:path>');
  }

  return out;
}

/**
 * 对任意值递归脱敏。字符串直接处理，数组与普通对象逐项处理，
 * 其他类型原样返回（数字、布尔、null 不含敏感内容）。
 *
 * 深度上限用于防止在循环引用或极深结构上失控；超深时用占位符截断。
 *
 * @param {unknown} value
 * @param {RedactOptions} [options]
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactValue(value, options = {}, depth = 0) {
  if (depth > 12) return '<redacted:too-deep>';
  if (typeof value === 'string') return redactString(value, options);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options, depth + 1));

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactValue(item, options, depth + 1);
  }
  return out;
}

/**
 * 判断一段文本是否包含疑似密钥。用于在写日志前给出提示，不用于替换。
 * @param {string} input
 * @returns {boolean}
 */
export function containsSecret(input) {
  if (typeof input !== 'string' || input.length === 0) return false;
  // 复用脱敏逻辑判断，而不是维护第二套规则：两份规则一定会漂移，
  // 导致"日志里已抹掉但提示说没有"或反之。
  return redactString(input) !== input;
}
