/**
 * costcast 估算内核。
 *
 * 纯函数，不依赖 DSH、不碰 DOM、不发请求。这样能脱离宿主单独跑测试。
 *
 * 数据来源是客户端的三个投影，字段名与形状以宿主实现为准：
 *
 *   tokenUsage      来自 dsh-token-meter，wire view 就是 state.totals，
 *                   即**会话累计**的四个扁平桶：
 *                   { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 *                   （zod .strict()，没有别的字段，也没有嵌套的 last/totals）
 *
 *   contextPressure 同样来自 dsh-token-meter。wire view 只有
 *                   { contextWindow?, pressureTokens?, projectedTokens? }
 *                   —— **没有 surfaceTokens**。projectedTokens 的定义是
 *                   "样本值加上此后上下文的净变化"，即下一次请求要发送的量。
 *
 *   sessionStats    来自 dsh-session-stats，用 turns / steps 估每轮步数。
 *
 * 估算模型：
 *   下一步输入 = projectedTokens（下次请求要重发的整个上下文）
 *     其中按本会话实测的缓存命中比例拆成 命中 / 未命中 两桶
 *   下一步输出 = 本会话每步平均输出（outputTokens / steps）
 *   一轮成本   = 单步成本 × 每轮步数区间
 *
 * 为什么输出必须给区间：输出单价是缓存命中价的 200 倍
 * （deepseek-flash 空闲档 4 元/M 对 0.02 元/M），
 * 实测输出只占 0.3% 的 token 却占 34% 的成本。
 */

/** 价格单位：元 / 百万 tokens。来源见 M0-侦察结论.md（官方文档，2026-10-12 查证）。 */
export const PRICE_TABLE = {
  'deepseek-flash': {
    cacheHit: { off: 0.02, peak: 0.04 },
    cacheMiss: { off: 1, peak: 2 },
    output: { off: 4, peak: 8 },
  },
  'deepseek-v4-pro': {
    cacheHit: { off: 0.15, peak: 0.3 },
    cacheMiss: { off: 4.5, peak: 9 },
    output: { off: 13.5, peak: 27 },
  },
};

/** 认不出的模型名用哪个价目档兜底。 */
export const DEFAULT_MODEL = 'deepseek-flash';

const PER_MILLION = 1e6;

/**
 * 判断某个时刻是否处于高峰时段。
 *
 * 官方规则：北京时间周一至周五（不含法定节假日）9:00–12:00 与 14:00–18:00 为高峰，
 * 其余时段为空闲。空闲价是高峰价的一半。
 *
 * 中国法定节假日无法内置成完整日历（每年调整），所以做成参数，
 * 默认空列表等于"只按周末判断"。宁可少判几个节假日，也不要写死过期日历。
 *
 * @param {Date} now - 待判断的时刻
 * @param {string[]} holidays - 法定节假日日期，格式 YYYY-MM-DD（北京时间）
 * @returns {boolean} 是否高峰时段
 */
export function isPeakHour(now = new Date(), holidays = []) {
  // 换算成北京时间（UTC+8），用 UTC 取值避免依赖运行环境的本地时区
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  const hour = beijing.getUTCHours();
  const weekday = beijing.getUTCDay(); // 0 = 周日
  const dateKey = beijing.toISOString().slice(0, 10);

  if (weekday === 0 || weekday === 6) return false;
  if (holidays.includes(dateKey)) return false;

  const morning = hour >= 9 && hour < 12;
  const afternoon = hour >= 14 && hour < 18;
  return morning || afternoon;
}

/**
 * 取价目档。
 * @param {string} model
 * @param {'off'|'peak'} tier
 */
export function priceOf(model, tier) {
  const table = PRICE_TABLE[model] ?? PRICE_TABLE[DEFAULT_MODEL];
  return {
    cacheHit: table.cacheHit[tier],
    cacheMiss: table.cacheMiss[tier],
    output: table.output[tier],
  };
}

/**
 * 算一组 token 花掉的钱。
 *
 * 缓存写没有独立价目，按未命中价计（保守，不会低报）。
 *
 * @param {{cacheReadTokens?:number, uncachedInputTokens?:number, cacheWriteTokens?:number, outputTokens?:number}} buckets
 * @param {string} model
 * @param {{tier?:'off'|'peak', now?:Date, holidays?:string[]}} [opts]
 * @returns {number} 元
 */
export function costOf(buckets, model = DEFAULT_MODEL, opts = {}) {
  const tier = opts.tier ?? (isPeakHour(opts.now ?? new Date(), opts.holidays ?? []) ? 'peak' : 'off');
  const price = priceOf(model, tier);

  const hit = (buckets?.cacheReadTokens ?? 0) / PER_MILLION;
  const miss = ((buckets?.uncachedInputTokens ?? 0) + (buckets?.cacheWriteTokens ?? 0)) / PER_MILLION;
  const out = (buckets?.outputTokens ?? 0) / PER_MILLION;

  return hit * price.cacheHit + miss * price.cacheMiss + out * price.output;
}

/** 输出 token 的估算带宽：以本会话每步平均输出为中心。 */
const OUTPUT_LOW_RATIO = 0.5;
const OUTPUT_HIGH_RATIO = 1.5;
const OUTPUT_FLOOR = 150;

/**
 * 估算下一步的成本区间。
 *
 * 输入侧几乎确定：下一次请求会把整个上下文重发一遍（大小由调用方给出），
 * 其中命中缓存的比例用本会话实测值。不确定的只有输出，所以带宽开在输出上。
 *
 * @param {{inputTokens:number, hitRatio:number, expectedOutput:number}} shape - 输入侧模型
 * @param {string} model - 模型名（价目档）
 * @param {object} [opts]
 * @returns {{low:number, mid:number, high:number, inputTokens:number, hitRatio:number, outputBand:[number,number]}}
 */
export function projectStep(shape, model = DEFAULT_MODEL, opts = {}) {
  const inputTokens = Math.max(0, shape?.inputTokens ?? 0);
  const hitRatio = Math.min(1, Math.max(0, shape?.hitRatio ?? 0));
  const expectedOutput = Math.max(0, shape?.expectedOutput ?? 0);

  const hit = inputTokens * hitRatio;
  const miss = inputTokens * (1 - hitRatio);

  const outLow = Math.max(OUTPUT_FLOOR, Math.round(expectedOutput * OUTPUT_LOW_RATIO));
  const outHigh = Math.max(OUTPUT_FLOOR * 2, Math.round(expectedOutput * OUTPUT_HIGH_RATIO));

  const at = (out) =>
    costOf({ cacheReadTokens: hit, uncachedInputTokens: miss, outputTokens: out }, model, opts);

  return {
    low: at(outLow),
    mid: at(expectedOutput),
    high: at(outHigh),
    inputTokens,
    hitRatio,
    outputBand: [outLow, outHigh],
  };
}

/** 每轮步数的估算带宽。 */
const STEPS_LOW_RATIO = 0.6;
const STEPS_HIGH_RATIO = 1.5;

/**
 * 估算「再问一轮」的总成本区间。
 *
 * 步数来自本会话的实测均值（sessionStats.steps / turns），
 * 没有历史时退回默认值并标出 fromHistory=false——UI 据此显示破折号，不编数字。
 *
 * @param {{low:number, mid:number, high:number}} stepRange - projectStep 的结果
 * @param {{turns?:number, steps?:number}} sessionStats
 * @param {{defaultStepsPerTurn?:number}} [opts]
 */
export function projectTurn(stepRange, sessionStats = {}, opts = {}) {
  const turns = sessionStats?.turns ?? 0;
  const steps = sessionStats?.steps ?? 0;

  const hasHistory = turns > 0 && steps > 0;
  const avg = hasHistory ? steps / turns : (opts.defaultStepsPerTurn ?? 8);

  const low = Math.max(1, Math.round(avg * STEPS_LOW_RATIO));
  const high = Math.max(low + 1, Math.round(avg * STEPS_HIGH_RATIO));

  return {
    low: stepRange.low * low,
    high: stepRange.high * high,
    stepsLow: low,
    stepsHigh: high,
    avgSteps: Math.round(avg * 10) / 10,
    fromHistory: hasHistory,
  };
}

/** 上下文占比超过这个值时提示开新会话。 */
export const PRESSURE_HINT_RATIO = 0.7;

/**
 * 汇总一次估算，给 UI 直接消费。
 *
 * @param {{tokenUsage?:object, sessionStats?:object, contextPressure?:object}} projections
 * @param {{model?:string, now?:Date, holidays?:string[], defaultStepsPerTurn?:number}} [config]
 */
export function estimate(projections = {}, config = {}) {
  const model = config.model ?? DEFAULT_MODEL;
  const now = config.now ?? new Date();
  const holidays = config.holidays ?? [];
  const tier = isPeakHour(now, holidays) ? 'peak' : 'off';

  const usage = projections.tokenUsage ?? {};
  const stats = projections.sessionStats ?? {};
  const pressure = projections.contextPressure ?? {};

  // 会话累计的四个扁平桶
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const uncached = usage.uncachedInputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const billedInput = cacheRead + cacheWrite + uncached;

  // 与宿主圆环同一套口径：优先用 projectedTokens（面向下一次请求）
  const usedTokens = pressure.projectedTokens ?? pressure.pressureTokens;
  const contextWindow = pressure.contextWindow ?? 0;

  const totals = {
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    uncachedInputTokens: uncached,
    outputTokens: output,
  };

  // 没有可依据的测量值时返回 null，由界面显示 `—`。
  // 不用兜底值凑一个看起来合理的数字：估出来的值会被当成真账用。
  const hasData = billedInput + output > 0 || usedTokens !== undefined;

  if (!hasData) {
    return {
      model,
      tier,
      step: null,
      turn: null,
      spent: 0,
      usedTokens: 0,
      contextWindow,
      pressureRatio: 0,
      showPressureHint: false,
      hasData: false,
      hitRatio: 0,
      avgOutputPerStep: 0,
      totals,
    };
  }

  const spent = costOf(totals, model, { tier });

  // 缓存命中比例：本会话实测，未命中与缓存写都算没命中
  const hitRatio = billedInput > 0 ? cacheRead / billedInput : 0;

  // 下一次请求要重发的上下文；没有投影时退回本会话已计费的输入量
  const nextInput = usedTokens ?? billedInput;

  // 每步平均输出
  const steps = stats.steps ?? 0;
  const avgOutputPerStep = steps > 0 ? output / steps : output;

  const step = projectStep(
    { inputTokens: nextInput, hitRatio, expectedOutput: avgOutputPerStep },
    model,
    { tier },
  );
  const turn = projectTurn(step, stats, { defaultStepsPerTurn: config.defaultStepsPerTurn });

  const ratio = contextWindow > 0 ? Math.min(1, nextInput / contextWindow) : 0;

  return {
    model,
    tier,
    step,
    turn,
    spent,
    usedTokens: nextInput,
    contextWindow,
    pressureRatio: ratio,
    showPressureHint: ratio >= PRESSURE_HINT_RATIO,
    hasData: true,
    hitRatio,
    avgOutputPerStep,
    totals,
  };
}

/** 压缩数字：1234 → 1.2K，1234567 → 1.2M。仪器读数风格，不四舍五入到失真。 */
export function formatTokens(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${trim(n / 1e3)}K`;
  return `${trim(n / 1e6)}M`;
}

function trim(v) {
  return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

/**
 * 金额格式化。
 *
 * 成本常常小于一角，所以小数位数按量级走：小于 0.1 元保留三位，
 * 否则保留两位。不显示"约""~"这类字眼，区间用连接号表达。
 */
export function formatCNY(value) {
  const v = Number(value) || 0;
  if (v === 0) return '0';
  if (v < 0.001) return '<0.001';
  if (v < 0.1) return v.toFixed(3);
  if (v < 100) return v.toFixed(2);
  return String(Math.round(v));
}

/** 区间格式化：low == high 时退化成单值。 */
export function formatRange(low, high) {
  const a = formatCNY(low);
  const b = formatCNY(high);
  return a === b ? `¥${a}` : `¥${a}–${b}`;
}

/** 百分比格式化，用于缓存命中率展示。 */
export function formatPercent(ratio) {
  const v = Number(ratio) || 0;
  return `${Math.round(v * 100)}%`;
}
