/**
 * 估算内核的单元测试。
 *
 * 用 node 内置测试跑，不引第三方依赖：
 *   node --test test/estimate.test.mjs test/client.test.mjs
 *
 * 主用例挑了能整除的数字，期望值全部手算写死——
 * 把实现跑一遍抄回来只能证明"代码没变"，证明不了"算得对"。
 * 另有一组用真实会话数字做量级核对。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRICE_TABLE,
  DEFAULT_MODEL,
  isPeakHour,
  priceOf,
  costOf,
  projectStep,
  projectTurn,
  estimate,
  formatTokens,
  formatCNY,
  formatRange,
  formatPercent,
  PRESSURE_HINT_RATIO,
} from '../src/estimate.js';

/** 构造一个"北京时间某时刻"的 Date：北京时间 = UTC+8。 */
const bj = (y, m, d, hh, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh - 8, mm));

/** 钉死在空闲时段：北京时间 2026-10-12 20:00（周一）。 */
const OFF_PEAK = bj(2026, 10, 12, 20);

const close = (actual, expected, tol = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tol,
    `期望 ${expected}，实际 ${actual}（差 ${Math.abs(actual - expected)}）`,
  );

/**
 * 主夹具。数字取整，方便手算：
 *   billedInput = 990,000 + 10,000 = 1,000,000，命中率 0.99
 *   每步平均输出 = 100,000 / 100 = 1,000
 *   下一次请求上下文 = 1,000,000（占满 1M 窗口）
 */
const FIXTURE = {
  tokenUsage: {
    cacheReadTokens: 990000,
    uncachedInputTokens: 10000,
    cacheWriteTokens: 0,
    outputTokens: 100000,
  },
  sessionStats: { turns: 10, steps: 100 },
  contextPressure: { projectedTokens: 1000000, contextWindow: 1000000 },
};

describe('isPeakHour 时段判断', () => {
  // 2026-10-12 是周一
  test('周一 9:00 起进入高峰', () => {
    assert.equal(isPeakHour(bj(2026, 10, 12, 8, 59)), false);
    assert.equal(isPeakHour(bj(2026, 10, 12, 9, 0)), true);
  });

  test('周一 12:00 午休不算高峰', () => {
    assert.equal(isPeakHour(bj(2026, 10, 12, 11, 59)), true);
    assert.equal(isPeakHour(bj(2026, 10, 12, 12, 0)), false);
    assert.equal(isPeakHour(bj(2026, 10, 12, 13, 59)), false);
  });

  test('周一 14:00 下午高峰开始', () => {
    assert.equal(isPeakHour(bj(2026, 10, 12, 14, 0)), true);
  });

  test('周一 18:00 起离开高峰', () => {
    assert.equal(isPeakHour(bj(2026, 10, 12, 17, 59)), true);
    assert.equal(isPeakHour(bj(2026, 10, 12, 18, 0)), false);
  });

  test('周末全天不算高峰', () => {
    assert.equal(isPeakHour(bj(2026, 10, 10, 10)), false); // 周六
    assert.equal(isPeakHour(bj(2026, 10, 11, 10)), false); // 周日
    assert.equal(isPeakHour(bj(2026, 10, 11, 15)), false);
  });

  test('法定节假日不算高峰', () => {
    const holidays = ['2026-10-12'];
    assert.equal(isPeakHour(bj(2026, 10, 12, 10), holidays), false);
    // 同一天不在列表里时仍是高峰，确认是列表在起作用
    assert.equal(isPeakHour(bj(2026, 10, 12, 10), []), true);
  });

  test('换算北京时区，不受运行环境本地时区影响', () => {
    const instant = new Date('2026-10-12T01:00:00Z'); // 北京 09:00
    assert.equal(isPeakHour(instant), true);
  });
});

describe('价格表', () => {
  test('空闲价是高峰价的一半', () => {
    for (const table of Object.values(PRICE_TABLE)) {
      close(table.cacheHit.off * 2, table.cacheHit.peak, 1e-9);
      close(table.cacheMiss.off * 2, table.cacheMiss.peak, 1e-9);
      close(table.output.off * 2, table.output.peak, 1e-9);
    }
  });

  test('认不出的模型名退回默认档，不抛错', () => {
    assert.equal(priceOf('不存在的模型', 'off').output, PRICE_TABLE[DEFAULT_MODEL].output.off);
  });
});

describe('costOf 成本计算', () => {
  test('四个桶分别计价，缓存写按未命中价算', () => {
    // 0.9×0.02 + (0.05+0.05)×1 + 0.01×4 = 0.018 + 0.1 + 0.04 = 0.158
    const cost = costOf(
      { cacheReadTokens: 900000, uncachedInputTokens: 50000, cacheWriteTokens: 50000, outputTokens: 10000 },
      'deepseek-flash',
      { tier: 'off' },
    );
    close(cost, 0.158, 1e-9);
  });

  test('高峰价正好是空闲价的两倍', () => {
    const buckets = { cacheReadTokens: 123456, uncachedInputTokens: 7890, outputTokens: 4567 };
    const off = costOf(buckets, 'deepseek-flash', { tier: 'off' });
    const peak = costOf(buckets, 'deepseek-flash', { tier: 'peak' });
    close(peak, off * 2, 1e-9);
  });

  test('输出单价是缓存命中价的 200 倍，所以输出对成本影响大', () => {
    const hit = costOf({ cacheReadTokens: 1e6 }, 'deepseek-flash', { tier: 'off' });
    const out = costOf({ outputTokens: 1e6 }, 'deepseek-flash', { tier: 'off' });
    close(out / hit, 200, 1e-6);
  });

  test('空分桶算作零成本', () => {
    assert.equal(costOf({}, 'deepseek-flash', { tier: 'off' }), 0);
    assert.equal(costOf(null, 'deepseek-flash', { tier: 'off' }), 0);
  });

  test('真实会话数字量级核对', () => {
    // 缓存读 182,673,664 / 未缓存 4,603,456 / 输出 368,734（空闲价）
    // = 3.65347328 + 4.603456 + 1.474936 = 9.73186528
    const totals = {
      cacheReadTokens: 182673664,
      uncachedInputTokens: 4603456,
      outputTokens: 368734,
    };
    close(costOf(totals, 'deepseek-flash', { tier: 'off' }), 9.73186528, 1e-6);
  });
});

describe('projectStep 下一步区间', () => {
  test('输入侧按命中率拆分，输出侧开带宽（手算核对）', () => {
    const s = projectStep(
      { inputTokens: 1000000, hitRatio: 0.99, expectedOutput: 1000 },
      'deepseek-flash',
      { tier: 'off' },
    );
    // 命中 990,000 → 0.99×0.02 = 0.0198
    // 未命中 10,000 → 0.01×1  = 0.01
    // outLow = max(150, 500)  = 500  → 0.002
    // outHigh = max(300, 1500) = 1500 → 0.006
    close(s.low, 0.0198 + 0.01 + 0.002, 1e-9);
    close(s.high, 0.0198 + 0.01 + 0.006, 1e-9);
    close(s.mid, 0.0198 + 0.01 + 0.004, 1e-9);
    assert.deepEqual(s.outputBand, [500, 1500]);
    assert.equal(s.inputTokens, 1000000);
  });

  test('区间有序，中值落在里面', () => {
    const s = projectStep(
      { inputTokens: 1000000, hitRatio: 0.99, expectedOutput: 1000 },
      'deepseek-flash',
      { tier: 'off' },
    );
    assert.ok(s.low < s.mid && s.mid < s.high);
  });

  test('命中率被夹在 0..1，输入不会算成负数', () => {
    const s = projectStep({ inputTokens: 1000, hitRatio: 5, expectedOutput: 0 }, 'deepseek-flash', { tier: 'off' });
    assert.equal(s.hitRatio, 1);
    assert.ok(s.low > 0);
  });

  test('输出为 0 时也给非退化的带宽', () => {
    const s = projectStep({ inputTokens: 100000, hitRatio: 0.5, expectedOutput: 0 }, 'deepseek-flash', { tier: 'off' });
    assert.ok(s.high > s.low);
    assert.ok(s.outputBand[0] >= 150);
  });
});

describe('projectTurn 一轮区间', () => {
  const step = { low: 0.0318, mid: 0.0338, high: 0.0358 };

  test('用本会话实测的每轮步数', () => {
    // 10 轮 100 步 → 均值 10；下界 round(6)=6，上界 round(15)=15
    const t = projectTurn(step, { turns: 10, steps: 100 });
    assert.equal(t.stepsLow, 6);
    assert.equal(t.stepsHigh, 15);
    assert.equal(t.avgSteps, 10);
    assert.equal(t.fromHistory, true);
    close(t.low, 0.0318 * 6, 1e-9);
    close(t.high, 0.0358 * 15, 1e-9);
  });

  test('没有历史时退回默认步数，并标明不是实测', () => {
    const t = projectTurn(step, {}, { defaultStepsPerTurn: 8 });
    assert.equal(t.fromHistory, false);
    assert.equal(t.avgSteps, 8);
    assert.ok(t.stepsHigh > t.stepsLow);
  });

  test('上界永远大于下界，不会出现零宽', () => {
    const t = projectTurn(step, { turns: 1, steps: 1 });
    assert.ok(t.stepsHigh > t.stepsLow);
    assert.ok(t.high > t.low);
  });
});

describe('estimate 汇总', () => {
  test('组装出 UI 需要的全部字段（手算核对）', () => {
    const e = estimate(FIXTURE, { model: 'deepseek-flash', now: OFF_PEAK });

    assert.equal(e.hasData, true);
    assert.equal(e.tier, 'off');
    assert.equal(e.hitRatio, 0.99);
    close(e.avgOutputPerStep, 1000, 1e-9);

    // 会话累计 = 0.99×0.02 + 0.01×1 + 0.1×4 = 0.0198 + 0.01 + 0.4 = 0.4298
    close(e.spent, 0.4298, 1e-9);

    // 下一次请求的上下文取 projectedTokens
    assert.equal(e.usedTokens, 1000000);
    assert.equal(e.contextWindow, 1000000);
    assert.equal(e.pressureRatio, 1);
    assert.equal(e.showPressureHint, true);

    close(e.step.low, 0.0318, 1e-9);
    close(e.step.high, 0.0358, 1e-9);
    close(e.turn.low, 0.0318 * 6, 1e-9);
    close(e.turn.high, 0.0358 * 15, 1e-9);
  });

  test('上下文未超阈值时不提示', () => {
    const e = estimate(
      { ...FIXTURE, contextPressure: { projectedTokens: 500000, contextWindow: 1000000 } },
      { now: OFF_PEAK },
    );
    assert.equal(e.showPressureHint, false);
    assert.ok(e.pressureRatio < PRESSURE_HINT_RATIO);
  });

  test('高峰时段自动识别，成本翻倍', () => {
    const off = estimate(FIXTURE, { now: OFF_PEAK });
    const peak = estimate(FIXTURE, { now: bj(2026, 10, 12, 10) });
    assert.equal(peak.tier, 'peak');
    close(peak.spent, off.spent * 2, 1e-9);
    close(peak.step.mid, off.step.mid * 2, 1e-9);
  });

  test('没有 contextPressure 时退回本会话已计费输入量', () => {
    const e = estimate({ ...FIXTURE, contextPressure: undefined }, { now: OFF_PEAK });
    assert.equal(e.hasData, true);
    assert.equal(e.usedTokens, 1000000); // billedInput = 990,000 + 10,000
    assert.equal(e.pressureRatio, 0);
  });

  test('没有任何数据时返回 null，不编数字', () => {
    const e = estimate({}, { now: OFF_PEAK });
    assert.equal(e.hasData, false);
    assert.equal(e.step, null);
    assert.equal(e.turn, null);
    assert.equal(e.spent, 0);
    assert.equal(e.showPressureHint, false);
  });

  test('只有上下文、没有用量时仍可估（首次请求全部按未命中价）', () => {
    const e = estimate(
      { contextPressure: { projectedTokens: 20000, contextWindow: 1000000 } },
      { now: OFF_PEAK },
    );
    assert.equal(e.hasData, true);
    assert.equal(e.hitRatio, 0); // 没有缓存命中记录
    // 20,000 全部未命中 → 0.02×1 = 0.02；输出按下限 150 → 0.0006
    close(e.step.low, 0.02 + 0.0006, 1e-9);
  });

  test('缓存写计入未命中侧，不会被漏掉', () => {
    const withWrite = estimate(
      {
        tokenUsage: { cacheReadTokens: 0, uncachedInputTokens: 0, cacheWriteTokens: 500000, outputTokens: 0 },
        sessionStats: {},
      },
      { now: OFF_PEAK },
    );
    close(withWrite.spent, 0.5, 1e-9);
    assert.equal(withWrite.hitRatio, 0);
  });
});

describe('格式化', () => {
  test('token 数压缩', () => {
    assert.equal(formatTokens(562), '562');
    assert.equal(formatTokens(1234), '1.2K');
    assert.equal(formatTokens(564480), '564K');
    assert.equal(formatTokens(1234567), '1.2M');
  });

  test('金额按量级保留位数', () => {
    assert.equal(formatCNY(0), '0');
    assert.equal(formatCNY(0.0005), '<0.001');
    assert.equal(formatCNY(0.0176), '0.018');
    assert.equal(formatCNY(0.5), '0.50');
    assert.equal(formatCNY(150.4), '150');
  });

  test('区间格式化，相等时退化成单值', () => {
    assert.equal(formatRange(0.0318, 0.0358), '¥0.032–0.036');
    assert.equal(formatRange(0.5, 0.5), '¥0.50');
  });

  test('百分比', () => {
    assert.equal(formatPercent(0.99), '99%');
    assert.equal(formatPercent(0), '0%');
  });
});
