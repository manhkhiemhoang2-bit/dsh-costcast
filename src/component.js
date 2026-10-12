/**
 * 读数条组件。
 *
 * 这是一个工厂：宿主（client.js 的外壳）把 React、createElement 和估算函数传进来，
 * 返回真正的组件。这样估算逻辑只有一份源码，构建时内联进浏览器包。
 *
 * 设计约束（来自规划）：
 *   - 仪器读数风格，不出现"智能""AI""预估为您"这类词
 *   - 数字用等宽 + tabular-nums
 *   - 颜色只用主题 token，深浅色主题都要能看
 *   - 没数据就什么都不渲染，不编数字
 *   - 位置在输入栏正上方（conversation.input.dock），展开面板朝上开
 */

/** 价格档绑定的模型。客户端投影里没有模型名，先用配置常量。 */
export const MODEL = 'deepseek-flash';

/** 曲线最多保留多少步。 */
const HISTORY_LIMIT = 60;

/** 与宿主 TodoPanel 一致的宽度算法，让读数条和输入卡片左右对齐。 */
const WIDTH = 'calc(100% - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-side-clearance, 0px) - 4 * var(--dsh-composer-dock-inset, 0px))';
const MAX_WIDTH = 'calc(var(--dsh-composer-card-max-width, 100%) - 4 * var(--dsh-composer-dock-inset, 0px))';

const LABEL = 'var(--dsw-alias-label-tertiary)';
const VALUE = 'var(--dsw-alias-label-secondary)';
const STRONG = 'var(--dsw-alias-label-primary)';
const BORDER = 'var(--dsw-alias-border-l1)';
const SURFACE = 'var(--dsw-specific-menu)';
const WARN = 'var(--dsw-alias-state-warn-label)';
const MONO = 'var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

const stripStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  width: WIDTH,
  maxWidth: MAX_WIDTH,
  margin: '0 auto',
  padding: '2px 4px',
  border: 0,
  background: 'transparent',
  color: LABEL,
  font: 'inherit',
  fontSize: '12px',
  lineHeight: '20px',
  textAlign: 'left',
  cursor: 'pointer',
};

const numStyle = {
  fontFamily: MONO,
  fontVariantNumeric: 'tabular-nums',
  color: VALUE,
};

const sepStyle = { color: BORDER, userSelect: 'none' };

const panelStyle = {
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  margin: '0 auto',
  width: WIDTH,
  maxWidth: MAX_WIDTH,
  boxSizing: 'border-box',
  padding: '10px 12px 12px',
  border: '1px solid ' + BORDER,
  borderRadius: 'var(--dsw-radius-lg, 8px)',
  background: SURFACE,
  boxShadow: 'var(--dsw-elevation-panel, 0 6px 24px rgba(0,0,0,.18))',
  fontSize: '12px',
  lineHeight: '20px',
  color: VALUE,
  zIndex: 5,
};

const rowStyle = { display: 'flex', alignItems: 'baseline', gap: '10px' };
const rowLabelStyle = { color: LABEL, flex: 'none', width: '72px' };
const titleStyle = {
  color: STRONG,
  fontSize: '12px',
  fontWeight: 500,
  margin: '0 0 8px',
  letterSpacing: '0.02em',
};

/**
 * 蓝色巨鲸标记，放在读数条最左边作为项目标识。
 * 图形取自微软 Fluent Emoji 的 whale，MIT 协议，出处见 THIRD-PARTY.md。
 */
const WHALE_PATHS = [
  {
    fill: '#00a6ed',
    d: 'M24.04 6.508C27.007 9.5 29 12.953 29 16.468c0 6.422-1.95 10.392-6.648 12.315a16 16 0 0 1-1.652-.318l-.012.582c-.105.563-.485 1.352-1.625.703c-.84-.478-2.112-1.55-2.33-4.281c-.511-1.271-.617-2.91-.733-4.969c-.164-2.91-3.078-3.89-5-4c-1.84-.105-8.316-.467-8.869-.498a15 15 0 0 1-.01-1.111c0-2.66 3.363-4.9 5.713-4.9h6.55c3.46 0 6.27 2.81 6.27 6.27c-.17 2.411 3.373 3.405 3.82.78c.492-2.896-.591-6.166-2.435-8.494c-.195-.047-.308-.047-.445.047c-1.258 1.258-2.16 1.312-3.852.914a1 1 0 0 0-.239-.103c-.228-.077-.435-.147-.331-.608c.14-.625 1.125-1.719 1.125-1.719c.773-.906 1.758-1.11 2.226-1.055c.402.047.515-.068.58-.135l.03-.029c.065-.051.133-.437.133-.437c-.164-.875.043-1.678.547-2.383c0 0 .882-1.266 1.687-1.344c.72-.07.803.37.879.768q.012.071.027.139c.334 1.535.17 1.902-.215 2.765c-.065.147-.137.308-.214.492c-.13.308-.058.434.038.605zM8.219 29.938c-1.735 0-3.64-2.438-3.11-5.922c.313.2 2.615 2.052 3.75 3.14c.329.844.11 2.782-.64 2.782',
  },
  {
    fill: '#1c1c1c',
    d: 'M15.517 15a.61.61 0 0 1-.604-.604v-.758c0-.33.274-.604.604-.604s.604.274.604.604v.758a.604.604 0 0 1-.604.604',
  },
  {
    fill: '#aeddff',
    d: 'M20.706 28.208q.745.278 1.692.556q-.84.348-1.8.608q.06-.166.09-.325zm-3.973-4.468c-.107-.771-.157-1.671-.217-2.74l-.016-.281c-.164-2.911-3.766-4.61-5.687-4.719c-1.839-.105-8.138-.01-8.682 0c.339 7.399 6.034 14.639 13.885 14.095a27 27 0 0 0 3.007-.367c-1-.583-2.564-2.007-2.29-5.988',
  },
];

/**
 * @param {{React:object, h:function, estimate:function, costOf:function,
 *          formatTokens:function, formatCNY:function, formatRange:function,
 *          formatPercent:function, DEFAULT_MODEL:string}} deps
 */
export function createCostStrip(deps) {
  const { React, h, estimate, costOf, formatTokens, formatCNY, formatRange, formatPercent } = deps;
  // 时钟做成可注入的：价格分峰谷，测试要能钉死时段，否则结果会随时钟漂
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();

  /** 成本拆解：把会话累计的三桶分别折成钱。 */
  function breakdown(totals, model, tier) {
    const t = totals || {};
    return [
      { key: 'cacheReadTokens', label: '缓存读', tokens: t.cacheReadTokens || 0, cost: costOf({ cacheReadTokens: t.cacheReadTokens || 0 }, model, { tier }) },
      { key: 'outputTokens', label: '输出', tokens: t.outputTokens || 0, cost: costOf({ outputTokens: t.outputTokens || 0 }, model, { tier }) },
      { key: 'uncachedInputTokens', label: '未缓存', tokens: (t.uncachedInputTokens || 0) + (t.cacheWriteTokens || 0), cost: costOf({ uncachedInputTokens: (t.uncachedInputTokens || 0) + (t.cacheWriteTokens || 0) }, model, { tier }) },
    ];
  }

  /** 蓝鲸标记。尺寸小、不参与布局扩张，只作标识。 */
  function Whale() {
    return h(
      'svg',
      {
        width: 15,
        height: 15,
        viewBox: '0 0 32 32',
        'aria-hidden': 'true',
        style: { display: 'block', flex: 'none' },
      },
      WHALE_PATHS.map((p, i) => h('path', { key: i, fill: p.fill, d: p.d })),
    );
  }

  /** 每步成本曲线：细柱，归一化到最大值。 */
  function Sparkline({ points }) {
    const W = 108;
    const H = 22;
    if (!points || points.length < 2) {
      return h('span', { style: { ...numStyle, color: LABEL } }, '—');
    }
    const max = Math.max.apply(null, points.map((p) => p.cost)) || 1;
    const barW = W / points.length;
    return h(
      'svg',
      { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', style: { display: 'block', flex: 'none' } },
      points.map((p, i) => {
        const bh = Math.max(1, Math.round((p.cost / max) * (H - 2)));
        return h('rect', {
          key: p.key,
          x: (i * barW).toFixed(2),
          y: H - bh,
          width: Math.max(1, barW - 1).toFixed(2),
          height: bh,
          fill: 'currentColor',
          opacity: (0.18 + 0.62 * (p.cost / max)).toFixed(2),
        });
      }),
    );
  }

  function CostStrip(props) {
    // useProjection 由框架的标准 kit 提供。缺失时下面明确提示，不让组件无声消失。
    const read = typeof props.useProjection === 'function' ? props.useProjection : null;

    const tokenUsage = read ? read('tokenUsage') : undefined;
    const sessionStats = read ? read('sessionStats') : undefined;
    const contextPressure = read ? read('contextPressure') : undefined;

    const [open, setOpen] = React.useState(false);
    const [history, setHistory] = React.useState([]);
    const rootRef = React.useRef(null);

    const est = estimate(
      { tokenUsage, sessionStats, contextPressure },
      { model: MODEL, now: now() },
    );

    // 累积每步成本。投影只给会话累计，每步的历史要靠自己按 steps 计数攒。
    const stepKey = sessionStats && typeof sessionStats.steps === 'number' ? sessionStats.steps : null;
    const stepCost = est.step ? est.step.mid : null;

    React.useEffect(() => {
      if (stepKey === null || stepCost === null) return;
      setHistory((prev) => {
        if (prev.length > 0 && prev[prev.length - 1].key === stepKey) return prev;
        const next = prev.concat([{ key: stepKey, cost: stepCost }]);
        return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
      });
    }, [stepKey, stepCost]);

    // 点外面或按 Esc 收起
    React.useEffect(() => {
      if (!open) return undefined;
      const onDown = (e) => {
        if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('pointerdown', onDown);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('pointerdown', onDown);
        document.removeEventListener('keydown', onKey);
      };
    }, [open]);

    // 框架没给 useProjection：说明标准 kit 没送到，报出来
    if (read === null) {
      return h(
        'div',
        { style: { ...stripStyle, cursor: 'default' } },
        h('span', { style: { color: WARN } }, '成本预估：拿不到投影接口'),
      );
    }

    // 有接口但还没有测量值：什么都不显示，不编数字
    if (!est.hasData) return null;

    const tierLabel = est.tier === 'peak' ? '高峰价' : '空闲价';
    const stepText = est.step ? formatRange(est.step.low, est.step.high) : '—';
    // 本轮步数只有本会话攒够样本才敢给区间；否则显示破折号，
    // 不用"默认 8 步"这类兜底值充数——那不是测量，是编。
    const turnKnown = !!(est.turn && est.turn.fromHistory);
    const turnText = turnKnown ? formatRange(est.turn.low, est.turn.high) : '—';
    const pct = Math.round((est.pressureRatio || 0) * 100);

    const header = h(
      'button',
      {
        type: 'button',
        style: stripStyle,
        onClick: () => setOpen((v) => !v),
        'aria-expanded': open,
        'aria-label': `成本预估：下一步 ${stepText}，本轮 ${turnText}`,
        title: '点击查看成本构成与每步走势',
      },
      h(Whale, { key: 'whale' }),
      h('span', null, '上下文'),
      h('span', { style: numStyle }, formatTokens(est.usedTokens)),
      h('span', { style: sepStyle }, '│'),
      h('span', null, '下一步'),
      h('span', { style: { ...numStyle, color: STRONG } }, stepText),
      h('span', { style: sepStyle }, '│'),
      h('span', null, '本轮'),
      h('span', { style: { ...numStyle, color: turnKnown ? VALUE : LABEL } }, turnText),
      h('span', { style: sepStyle }, '│'),
      h('span', { style: est.tier === 'peak' ? { color: WARN } : null }, tierLabel),
      h('span', { style: { marginLeft: 'auto', color: VALUE } }, h(Sparkline, { points: history })),
    );

    if (!open) return h('div', { ref: rootRef, style: { position: 'relative' } }, header);

    const rows = breakdown(est.totals, MODEL, est.tier);

    const panel = h(
      'div',
      { style: panelStyle, role: 'dialog', 'aria-label': '成本预估明细' },
      h('div', { style: titleStyle }, '成本预估'),
      h(
        'div',
        { style: { ...rowStyle, marginBottom: '6px' } },
        h('span', { style: rowLabelStyle }, '会话累计'),
        h('span', { style: { ...numStyle, color: STRONG } }, '¥' + formatCNY(est.spent)),
        h('span', { style: { color: LABEL } }, '按' + tierLabel + '计'),
      ),
      h(
        'div',
        { style: { ...rowStyle, marginBottom: '2px' } },
        h('span', { style: rowLabelStyle }, '构成'),
        h('span', { style: { color: LABEL } }, '本会话累计口径'),
      ),
      ...rows.map((r) =>
        h(
          'div',
          { style: { ...rowStyle, paddingLeft: '12px' }, key: r.key },
          h('span', { style: { ...rowLabelStyle, width: '60px', color: VALUE } }, r.label),
          h('span', { style: { ...numStyle, width: '70px' } }, formatTokens(r.tokens)),
          h('span', { style: { ...numStyle, width: '78px', textAlign: 'right' } }, '¥' + formatCNY(r.cost)),
        ),
      ),
      h(
        'div',
        { style: { ...rowStyle, marginTop: '8px' } },
        h('span', { style: rowLabelStyle }, '每步成本'),
        h('span', { style: { color: LABEL, marginRight: 'auto' } }, history.length > 0 ? history.length + ' 步' : '攒样本中'),
        h('span', { style: { color: VALUE } }, h(Sparkline, { points: history })),
      ),
      h(
        'div',
        { style: { marginTop: '8px', color: est.showPressureHint ? WARN : LABEL } },
        est.showPressureHint
          ? `上下文已占 ${pct}%，开新会话可把单步成本降回初始水平`
          : turnKnown
            ? `上下文占 ${pct}%，缓存命中 ${formatPercent(est.hitRatio)}。每多跑一步都要重发整个上下文，所以单步成本随会话变贵`
            : `上下文占 ${pct}%，缓存命中 ${formatPercent(est.hitRatio)}。本会话还没有步数样本，先给单步区间；跑过一轮就能估整轮`,
      ),
    );

    return h('div', { ref: rootRef, style: { position: 'relative' } }, header, panel);
  }

  return CostStrip;
}
