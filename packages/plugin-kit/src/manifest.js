/**
 * 清单与边界解析工具。
 *
 * 这个模块存在的理由：插件的 patch、配置与第三方数据都是不可信输入。
 * "在边界处解析，不要验证"——读进来就把形状固定下来，之后所有代码都可以信任它，
 * 而不必在每个使用点重复判断字段是否存在、类型是否正确。
 */

import { readFile } from 'node:fs/promises';

/** 主题 token 前缀。插件 UI 只能使用这些 token，见 docs/references/dsh-plugin-api.md。 */
export const THEME_TOKEN_PREFIX = '--dsw-alias-';

/** 宿主基线版本。升级 DSH 时这个值要与 docs/references/dsh-plugin-api.md 一起更新。 */
export const DSH_BASELINE_VERSION = '0.2.0-rc.2';

/**
 * @typedef {object} PluginManifest
 * @property {string} name
 * @property {string} version
 * @property {string} [description]
 * @property {string} [icon]
 * @property {boolean} isPrivate
 * @property {{ patch?: string }} bundle
 * @property {{ platform?: string, immediately?: boolean, inject?: string[] } | null} client
 * @property {string | null} clientEntry
 */

/**
 * 把任意输入解析为字符串数组；非数组或含非字符串元素时返回空数组并记录原因。
 * @param {unknown} value
 * @param {string} field
 * @param {(message: string) => void} [onProblem]
 * @returns {string[]}
 */
export function toStringArray(value, field, onProblem) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    onProblem?.(`${field} 应为数组，实际是 ${typeof value}，已忽略。`);
    return [];
  }
  const out = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else onProblem?.(`${field} 含非字符串元素（${typeof item}），已跳过。`);
  }
  return out;
}

/**
 * 解析插件清单。
 *
 * @param {string} file package.json 的绝对路径
 * @param {(message: string) => void} [onProblem] 诊断回调
 * @returns {Promise<PluginManifest | null>} 返回 null 表示清单不可信
 */
export async function readPluginManifest(file, onProblem) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    onProblem?.(`无法读取清单 ${file}：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    onProblem?.(`${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    onProblem?.(`${file} 的顶层不是对象。`);
    return null;
  }

  if (typeof parsed.name !== 'string' || parsed.name === '') {
    onProblem?.(`${file} 缺少 name。`);
    return null;
  }
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    onProblem?.(`${file} 缺少 version。`);
    return null;
  }

  const bundlePatch = parsed.dsh?.bundle?.patch;
  if (bundlePatch !== undefined && typeof bundlePatch !== 'string') {
    onProblem?.(`${file} 的 dsh.bundle.patch 不是字符串，已忽略。`);
  }

  /** @type {PluginManifest['client']} */
  let client = null;
  const rawClient = parsed.dsh?.client;
  if (rawClient !== undefined) {
    if (rawClient === null || typeof rawClient !== 'object' || Array.isArray(rawClient)) {
      onProblem?.(`${file} 的 dsh.client 不是对象，已忽略。`);
    } else {
      client = {
        platform: typeof rawClient.platform === 'string' ? rawClient.platform : undefined,
        immediately: typeof rawClient.immediately === 'boolean' ? rawClient.immediately : undefined,
        inject: toStringArray(rawClient.inject, 'dsh.client.inject', onProblem),
      };
    }
  }

  const clientExport = parsed.exports?.['./client'];
  const clientEntry =
    typeof clientExport === 'string'
      ? clientExport
      : typeof clientExport?.default === 'string'
        ? clientExport.default
        : null;
  if (client && !clientEntry) {
    onProblem?.(`${file} 声明了 dsh.client，但没有 "./client" 导出。`);
  }

  return {
    name: parsed.name,
    version: parsed.version,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    icon: typeof parsed.icon === 'string' ? parsed.icon : undefined,
    isPrivate: parsed.private === true,
    bundle: { patch: typeof bundlePatch === 'string' ? bundlePatch : undefined },
    client,
    clientEntry,
  };
}

/**
 * 校验一个 CSS 声明片段是否只使用了主题 token 与允许的通用属性。
 *
 * 这条检查的意义：插件的 UI 若写死颜色，会在宿主切换明暗主题时变得不可读，
 * 而这种问题在开发时的主题下往往看不出来。
 *
 * @param {string} css
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkThemeTokenUsage(css) {
  /** @type {string[]} */
  const problems = [];
  if (typeof css !== 'string') return { ok: true, problems };

  // 字面颜色：十六进制、rgb()/hsl()、具名颜色
  const colorPatterns = [
    { re: /#[0-9a-f]{3,8}\b/gi, what: '十六进制颜色' },
    { re: /\brgba?\s*\(/gi, what: 'rgb()/rgba() 颜色' },
    { re: /\bhsla?\s*\(/gi, what: 'hsl()/hsla() 颜色' },
  ];
  for (const { re, what } of colorPatterns) {
    const found = css.match(re);
    if (found)
      problems.push(
        `出现${what}（${found.slice(0, 3).join('、')}），应改用 ${THEME_TOKEN_PREFIX}* token。`,
      );
  }
  return { ok: problems.length === 0, problems };
}
