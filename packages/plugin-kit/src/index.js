/**
 * @dsh-plugins/plugin-kit 的汇总入口。
 *
 * 各模块也可以按子路径单独导入，避免只需要一个纯函数时把整包拉进来：
 *   import { redactString } from '@dsh-plugins/plugin-kit/redact';
 */

export { scanForApps, selectRunScripts, parsePackageJson, isIgnoredDir } from './app-scanner.js';

export {
  startSupervisedProcess,
  stopSupervisedProcess,
  isProcessAlive,
  resolveStopTimings,
} from './process-supervisor.js';

export { LogBuffer, readTail } from './log-buffer.js';

export { redactString, redactValue, containsSecret } from './redact.js';

export {
  readPluginManifest,
  checkThemeTokenUsage,
  toStringArray,
  THEME_TOKEN_PREFIX,
  DSH_BASELINE_VERSION,
} from './manifest.js';
