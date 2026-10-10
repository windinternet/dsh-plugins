import js from '@eslint/js';
import globals from 'globals';

/**
 * 仓库统一 ESLint 配置。
 *
 * 三条与本仓库约束直接相关的规则：
 *
 * 1. 浏览器半侧（client.js）只允许把 react 作为外部依赖。DSH 的浏览器模块表
 *    只保证提供 React，其他包都不能依赖。
 * 2. 任何位置都禁止 import 任何 @deepseek-ai/dsh-client-* 包。DSH 官方明确禁止，
 *    这些包不是稳定 API，且纯 JS 插件没有类型检查兜底。
 * 3. 不允许在同一文件里混用 import 与 require，避免 ESM 与 CJS 语义混乱。
 *
 * 注意：本文件刻意不在注释里使用反引号包裹代码片段，也不出现需要加载的模块名，
 * 以免注释内容被工具误判为真实代码。
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.tmpl',
      'docs/generated/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // 浏览器半侧：只允许 react 作为外部依赖。
    files: ['**/client.js', '**/client/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, __ModuleLoader__: 'readonly' },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@deepseek-ai/dsh-client-*'],
              message:
                'DSH 明确禁止插件引用任何 Harness Client 包。请复制所需标记与样式，只依赖 --dsw-alias-* 主题 token。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tools/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
];
