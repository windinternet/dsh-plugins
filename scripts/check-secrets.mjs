#!/usr/bin/env node
/**
 * 密钥与隐私扫描。
 *
 * 本仓库是公开仓库，任何一次误提交都会立即公开。这个脚本是提交前与 CI 的最后一道
 * 机械防线。它只做可机械判定的检查，也可以用 git commit --no-verify 绕过；绕过必须
 * 同时说明理由，并补上人工复核。
 *
 * 设计取舍：
 * - 只扫描 git 已跟踪的文件；未跟踪文件由 .gitignore 负责，扫它们只会产生噪音。
 * - 命中即失败（退出码 1），打印文件、行号、规则名与脱敏片段，便于定位。
 * - 允许行内注释 secret-scan:allow 加理由豁免单行，供测试夹具使用。
 * - 占位符（your-key、changeme、xxxx、${VAR} 等）不报错，避免开发者对告警脱敏。
 * - 规则与阈值集中在本文件顶部的 RULES，新增规则必须同时补测试。
 *
 * 用法：
 *   node scripts/check-secrets.mjs            扫描 git 已跟踪文件
 *   node scripts/check-secrets.mjs --staged   只扫描暂存区内容（供 pre-commit 使用）
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * 高置信度密钥指纹。宁可少报，也不要让开发者对告警脱敏。
 * @type {{ id: string, description: string, pattern: RegExp }[]}
 */
const RULES = [
  {
    id: 'private-key-block',
    description: '私钥材料（PEM 块）',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: 'openai-key',
    description: 'OpenAI 风格密钥',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API 密钥',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'github-token',
    description: 'GitHub 令牌',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  {
    id: 'aws-access-key',
    description: 'AWS Access Key ID',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'google-api-key',
    description: 'Google API 密钥',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'slack-token',
    description: 'Slack 令牌',
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  },
  {
    id: 'npm-token',
    description: 'npm 访问令牌',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
  },
  {
    id: 'jwt',
    description: 'JWT（可能携带真实凭据）',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    id: 'assigned-secret',
    description: '明确的密钥赋值（非占位符）',
    pattern:
      /(?:api[_-]?key|apikey|secret|passwd|password|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*[\x27\x22\x60]([A-Za-z0-9_\-./+=]{16,})[\x27\x22\x60]/i,
  },
  {
    id: 'url-with-credentials',
    description: 'URL 内嵌凭据',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]{6,}@[^\s/]+/i,
  },
];

/** 明显是占位符的取值，命中后不再报错。 */
const PLACEHOLDER =
  /^(?:x+|\*+|\.+|_+|<[^>]*>|\$\{[^}]*\}|your[-_ ].*|changeme|placeholder|example|test|dummy|fake|todo|none|null|undefined)$/i;

/** 扫描时跳过的路径前缀（相对仓库根）。 */
const SKIP_PATHS = ['docs/generated/', 'pnpm-lock.yaml', 'package-lock.json'];

/** 行内豁免标记。 */
const ALLOW_MARKER = 'secret-scan:allow';

/**
 * 把命中片段脱敏，只保留可定位的前缀。
 * @param {string} raw
 * @returns {string}
 */
function redact(raw) {
  const trimmed = raw.trim();
  if (trimmed.length <= 8) return '*'.repeat(trimmed.length);
  return trimmed.slice(0, 4) + '*'.repeat(Math.min(24, trimmed.length - 4));
}

/**
 * 列出待扫描文件。
 * @param {boolean} staged
 * @returns {string[]}
 */
function listFiles(staged) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files'];
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 读取文件内容；staged 模式下读暂存区版本，而不是工作区版本。
 * @param {string} file
 * @param {boolean} staged
 * @returns {string | null}
 */
function readContent(file, staged) {
  try {
    if (staged) return execFileSync('git', ['show', `:${file}`], { encoding: 'utf8' });
    return readFileSync(file, 'utf8');
  } catch {
    return null; // 二进制文件、已删除文件或无法解码
  }
}

/**
 * 判断一个规则命中是否应被放过。
 * @param {string} line
 * @param {RegExpExecArray} match
 * @returns {boolean}
 */
function isAllowed(line, match) {
  if (line.includes(ALLOW_MARKER)) return true;
  const captured = match[1];
  if (captured) {
    if (PLACEHOLDER.test(captured)) return true;
    if (/^(.)\1+$/.test(captured)) return true; // 值只有重复的同一字符
  }
  return false;
}

function main() {
  const staged = process.argv.includes('--staged');
  const files = listFiles(staged);
  /** @type {{ file: string, line: number, rule: string, description: string, snippet: string }[]} */
  const findings = [];

  for (const file of files) {
    if (SKIP_PATHS.some((prefix) => file.startsWith(prefix))) continue;
    const content = readContent(file, staged);
    if (content === null || content.includes('\u0000')) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.length > 4000) continue; // 压缩产物
      for (const rule of RULES) {
        const flags = rule.pattern.flags.includes('g')
          ? rule.pattern.flags
          : `${rule.pattern.flags}g`;
        const re = new RegExp(rule.pattern.source, flags);
        let match;
        while ((match = re.exec(line)) !== null) {
          if (!isAllowed(line, match)) {
            findings.push({
              file,
              line: i + 1,
              rule: rule.id,
              description: rule.description,
              snippet: redact(match[0]),
            });
          }
          if (match.index === re.lastIndex) re.lastIndex += 1; // 防零宽匹配死循环
        }
      }
    }
  }

  if (findings.length === 0) {
    console.log(`密钥扫描通过：检查了 ${files.length} 个已跟踪文件，未发现敏感信息。`);
    return;
  }

  console.error(`密钥扫描发现 ${findings.length} 处可疑内容：\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    规则：${f.rule}（${f.description}）`);
    console.error(`    片段：${f.snippet}`);
  }
  console.error(
    '\n处理方式：\n' +
      '  1. 若确为真实密钥：立刻从代码中移除、改用环境变量，并到对应平台轮换该密钥。\n' +
      '     仅从最新提交删除不够，git 历史仍然公开。参见 SECURITY.md。\n' +
      `  2. 若为测试夹具等误报：在该行加注释 ${ALLOW_MARKER}: <理由>。\n` +
      '  3. 不要为了通过检查而放宽 scripts/check-secrets.mjs 的规则。',
  );
  process.exitCode = 1;
}

main();
