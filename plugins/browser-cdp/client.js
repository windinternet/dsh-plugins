/**
 * browser-cdp 的 Client（浏览器）半侧。
 *
 * 硬约束（违反不会在构建期报错，只会在用户侧炸掉）：
 * - 只允许 require('react')。React 由浏览器模块表提供，不自行安装、不引 CDN。
 * - 禁止 require 任何 @deepseek-ai/dsh-client-* 包。官方明确禁止，且它们随版本变化。
 * - 样式只用 --dsw-alias-* 主题 token；字面色只出现在状态圆点上，那是状态语义。
 * - 工厂无副作用：定义与返回，注册放在 apply 里。
 *
 * 这一侧的职责刻意很小：把 Host 半侧的真实状态显示出来，让人知道浏览器现在是
 * 开着还是关着、端口是多少、profile 在哪。**不做操作按钮**——浏览器归插件所有，
 * 启停由智能体的工具驱动，面板多一套控制路径只会多一处状态不一致。
 */

window.__ModuleLoader__.load({
  id: '@dsh-plugins/browser-cdp',
  factory(require) {
    const React = require('react');

    const STATUS_ROUTE = '/plugin/browser-cdp/status';
    const POLL_INTERVAL_MS = 5000;

    /** 状态到中文标签的映射。未知状态如实显示"未知"，不猜。 */
    const STATE_LABEL = {
      running: '运行中',
      stopped: '未启动',
      exited: '已退出',
      unknown: '未知',
      unavailable: '状态不可用',
    };

    /** 状态圆点颜色。这是状态语义，不属于主题配色。 */
    const STATE_COLOR = {
      running: '#2ea043',
      stopped: '#8b949e',
      exited: '#d29922',
      unknown: '#a371f7',
      unavailable: '#f85149',
    };

    /**
     * 把状态接口的响应归类成一个状态键。
     *
     * @param {{ ok?: boolean, running?: boolean, status?: string } | null} data
     * @returns {'running' | 'stopped' | 'exited' | 'unknown' | 'unavailable'}
     */
    function stateOf(data) {
      if (data === null || data.ok !== true) return 'unavailable';
      if (data.running === true) return 'running';
      const status = typeof data.status === 'string' ? data.status : '';
      if (status.includes('已退出')) return 'exited';
      if (status.includes('未启动')) return 'stopped';
      return 'unknown';
    }

    /**
     * 一行摘要，例如 `browser-cdp · 运行中 · 端口 24000`。
     *
     * @param {'running' | 'stopped' | 'exited' | 'unknown' | 'unavailable'} state
     * @param {any} data
     * @returns {string}
     */
    function summaryOf(state, data) {
      const label = STATE_LABEL[state];
      if (state === 'running' && typeof data?.port === 'number')
        return `browser-cdp · ${label} · 端口 ${data.port}`;
      return `browser-cdp · ${label}`;
    }

    /**
     * 停靠区状态条。
     *
     * @returns {any}
     */
    function StatusDock() {
      const [data, setData] = React.useState(null);
      const [expanded, setExpanded] = React.useState(false);

      React.useEffect(() => {
        let cancelled = false;
        const load = async () => {
          try {
            const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } });
            const body = await response.json();
            if (!cancelled) setData(body);
          } catch {
            if (!cancelled) setData(null);
          }
        };
        load();
        const timer = setInterval(load, POLL_INTERVAL_MS);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, []);

      const state = stateOf(data);
      const summary = summaryOf(state, data);

      const dot = React.createElement('span', {
        'aria-hidden': 'true',
        style: {
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: STATE_COLOR[state],
          display: 'inline-block',
          flex: '0 0 auto',
        },
      });

      const label = React.createElement(
        'span',
        { style: { color: 'var(--dsw-alias-text-secondary)', fontSize: 12 } },
        summary,
      );

      const trigger = React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => setExpanded((previous) => !previous),
          title: '点击查看浏览器详情',
          'aria-expanded': expanded,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 8px',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-secondary)',
            borderRadius: 6,
            cursor: 'pointer',
            font: 'inherit',
            color: 'inherit',
          },
        },
        dot,
        label,
        React.createElement(
          'span',
          { style: { color: 'var(--dsw-alias-text-tertiary)', fontSize: 11 } },
          expanded ? '收起' : '详情',
        ),
      );

      if (!expanded) return React.createElement('div', { style: { padding: '2px 0' } }, trigger);

      const rows = [];
      if (state === 'unavailable') {
        rows.push('状态接口不可用（宿主可能没有组合 HTTP 服务）。工具本身不受影响。');
      } else {
        rows.push(`状态：${data?.status ?? '未知'}`);
        if (data?.browser)
          rows.push(`浏览器：${data.browser}（协议 ${data.protocolVersion ?? '未知'}）`);
        if (data?.product) rows.push(`产品：${data.product}`);
        if (data?.port) rows.push(`CDP 端点：http://127.0.0.1:${data.port}`);
        if (data?.profileDir) rows.push(`profile：${data.profileDir}`);
        if (data?.currentUrl) rows.push(`当前页面：${data.currentUrl}`);
        if (typeof data?.networkEntries === 'number') {
          rows.push(
            `已记录：${data.networkEntries} 条请求 / ${data.consoleEntries ?? 0} 条控制台消息`,
          );
        }
        if (data?.sandboxDisabled === true) {
          rows.push('注意：该实例以关闭浏览器沙箱的方式启动（启动阶段渲染进程未能存活）。');
        }
      }

      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '6px 8px',
            border: '1px solid var(--dsw-alias-border-secondary)',
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-secondary)',
          },
        },
        trigger,
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              fontSize: 11,
              color: 'var(--dsw-alias-text-tertiary)',
              wordBreak: 'break-all',
            },
          },
          ...rows.map((text, index) => React.createElement('div', { key: index }, text)),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'browser-cdp', order: 30 },
            () => React.createElement(StatusDock, null),
          ),
        );
      },
    };
  },
});
