/**
 * dockyard 的 Client（浏览器）半侧。
 *
 * 硬约束（违反不会在构建期报错，只会在用户侧炸掉）：
 * - 只允许 require('react')。React 由浏览器模块表提供，不自行安装、不引 CDN。
 * - 禁止 require 任何 @deepseek-ai/dsh-client-* 包。DSH 官方明确禁止，且会随版本变化。
 * - 样式只用 --dsw-alias-* 主题 token；字面色只出现在状态圆点上，那是状态语义而非配色。
 * - 不在组件外操作 DOM，不往 document.body 追加内容。
 * - 工厂必须无副作用：定义与返回，注册都放在 apply 里。
 *
 * 数据来源：Host 半侧注册的只读同源路由（/plugin/dockyard/status）。
 * 该路由只接受本机来源，且不返回 CORS 头，因此跨站页面读不到本机进程信息。
 */

window.__ModuleLoader__.load({
  id: '@dsh-plugins/dockyard',
  factory(require) {
    const React = require('react');

    const STATUS_ROUTE = '/plugin/dockyard/status';
    const POLL_INTERVAL_MS = 5000;

    /** 状态到中文标签的映射。未知状态刻意显示为"未知"，而不是猜一个。 */
    const STATUS_LABEL = {
      running: '运行中',
      starting: '启动中',
      stopping: '停止中',
      stopped: '已停止',
      crashed: '异常退出',
      unknown: '未知',
    };

    /** 状态到圆点颜色的映射。这是状态语义，不属于主题配色。 */
    const STATUS_COLOR = {
      running: '#2ea043',
      starting: '#d29922',
      stopping: '#d29922',
      stopped: '#8b949e',
      crashed: '#f85149',
      unknown: '#a371f7',
    };

    /**
     * 把毫秒时长渲染成简短的中文描述。
     * @param {number} ms
     * @returns {string}
     */
    function formatUptime(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '';
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return `${seconds} 秒`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes} 分钟`;
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
    }

    /**
     * 拉取一次状态快照。
     * @param {AbortSignal} signal
     * @returns {Promise<{ applications: any[], warnings: string[], error?: string }>}
     */
    async function fetchStatus(signal) {
      const response = await fetch(STATUS_ROUTE, {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`状态接口返回 ${response.status}`);
      }
      const body = await response.json();
      if (!body || body.ok !== true) {
        throw new Error(body && body.error ? body.error : '状态接口返回了非预期的内容');
      }
      return {
        applications: Array.isArray(body.applications) ? body.applications : [],
        warnings: Array.isArray(body.warnings) ? body.warnings : [],
      };
    }

    const styles = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '6px 10px',
        fontFamily: 'inherit',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        color: 'var(--dsw-alias-text-1, inherit)',
        cursor: 'pointer',
        userSelect: 'none',
        background: 'none',
        border: 'none',
        padding: 0,
        textAlign: 'left',
      },
      count: {
        fontVariantNumeric: 'tabular-nums',
        opacity: 0.85,
      },
      dot: {
        width: 7,
        height: 7,
        borderRadius: '50%',
        display: 'inline-block',
        marginRight: 6,
        flex: '0 0 auto',
      },
      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        maxHeight: 220,
        overflowY: 'auto',
      },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontSize: 12,
        color: 'var(--dsw-alias-text-2, inherit)',
      },
      name: { flex: '0 1 auto', color: 'var(--dsw-alias-text-1, inherit)' },
      meta: { flex: '1 1 auto', opacity: 0.7, fontSize: 11, overflowWrap: 'anywhere' },
      hint: { fontSize: 11, color: 'var(--dsw-alias-text-2, inherit)', opacity: 0.8 },
      error: { fontSize: 11, color: 'var(--dsw-alias-text-2, inherit)' },
    };

    /**
     * 输入框下方的 dock 槽位里显示本机服务状态。
     * @param {{ t?: (key: string) => string }} props
     */
    function DockyardDock(props) {
      const t = props.t ?? ((key) => key);
      const [state, setState] = React.useState({
        phase: 'loading',
        applications: [],
        warnings: [],
      });
      const [expanded, setExpanded] = React.useState(false);

      React.useEffect(() => {
        const controller = new AbortController();
        let timer = null;

        const tick = async () => {
          try {
            const data = await fetchStatus(controller.signal);
            if (controller.signal.aborted) return;
            setState({ phase: 'ready', applications: data.applications, warnings: data.warnings });
          } catch (error) {
            if (controller.signal.aborted) return;
            setState((previous) => ({
              phase: 'error',
              applications: previous.applications,
              warnings: previous.warnings,
              error: error instanceof Error ? error.message : String(error),
            }));
          } finally {
            if (!controller.signal.aborted) {
              timer = setTimeout(tick, POLL_INTERVAL_MS);
            }
          }
        };

        void tick();
        return () => {
          controller.abort();
          if (timer !== null) clearTimeout(timer);
        };
      }, []);

      const running = state.applications.filter((app) => app.status === 'running').length;
      const total = state.applications.length;
      const crashed = state.applications.filter((app) => app.status === 'crashed').length;

      // 没有托管任何应用、也没有错误时，整个 dock 不占空间。
      if (state.phase !== 'error' && total === 0) return null;

      const summary =
        state.phase === 'loading'
          ? t('loading')
          : crashed > 0
            ? `${running}/${total} ${t('runningSuffix')}，${crashed} ${t('crashedSuffix')}`
            : `${running}/${total} ${t('runningSuffix')}`;

      return React.createElement(
        'div',
        { style: styles.wrap },
        React.createElement(
          'button',
          {
            type: 'button',
            style: styles.header,
            'aria-expanded': expanded,
            title: t('toggleHint'),
            onClick: () => setExpanded((value) => !value),
          },
          React.createElement('span', { style: styles.count }, `dockyard · ${summary}`),
          React.createElement('span', { style: { opacity: 0.6 } }, expanded ? '▾' : '▸'),
        ),
        state.phase === 'error'
          ? React.createElement(
              'div',
              { style: styles.error },
              `${t('unavailable')}：${state.error}（${t('unavailableHint')}）`,
            )
          : null,
        expanded && total > 0
          ? React.createElement(
              'div',
              { style: styles.list },
              ...state.applications.map((app) =>
                React.createElement(
                  'div',
                  { key: app.id, style: styles.row },
                  React.createElement('span', {
                    style: {
                      ...styles.dot,
                      background: STATUS_COLOR[app.status] ?? STATUS_COLOR.unknown,
                    },
                    'aria-hidden': true,
                  }),
                  React.createElement('span', { style: styles.name }, app.name),
                  React.createElement(
                    'span',
                    { style: styles.meta },
                    `${STATUS_LABEL[app.status] ?? app.status}` +
                      (app.pid ? ` · pid ${app.pid}` : '') +
                      (app.uptimeMs ? ` · ${formatUptime(app.uptimeMs)}` : '') +
                      ` · ${app.command}`,
                  ),
                ),
              ),
              state.warnings.length > 0
                ? React.createElement('div', { style: styles.hint }, state.warnings.join(' / '))
                : null,
            )
          : null,
        expanded && total === 0
          ? React.createElement('div', { style: styles.hint }, t('empty'))
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 槽位名取自 docs/references/dsh-plugin-api.md 的已确认清单。
        // 用 try/catch 包住：槽位在某个组合里不存在时，只应记录一条警告，
        // 而不是让整个插件激活失败（激活失败会连带 Host 半侧一起不生效）。
        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'dockyard-status',
                order: 40,
              },
              DockyardDock,
            ),
          );
        } catch (error) {
          ctx.logger?.warn?.(
            `[dockyard] 无法注册状态面板：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    };
  },
});
