import { describe, expect, it } from 'vitest';
import { aggregateCandles, atrPct, htfTrend, withFilters } from '../src/strategies/filters.js';
import { assessRegime } from '../src/analysis/regime.js';
import { candlesFrom, cfg } from './helpers.js';
import type { Strategy } from '../src/strategies/base.js';

describe('higher-timeframe filter', () => {
  it('aggregates candles into larger buckets', () => {
    const c = candlesFrom(Array.from({ length: 23 }, (_, i) => 100 + i), 1_700_000_100_000, 10);
    const agg = aggregateCandles(c, 5);
    expect(agg.length).toBe(5);
    expect(agg[0].o).toBe(100);
    expect(agg[0].c).toBe(104);
    expect(agg[0].v).toBe(50);
    expect(agg[0].h).toBeGreaterThanOrEqual(104);
  });

  it('reports bullish/bearish trend and blocks buys against it', () => {
    const conf = cfg();
    const up = candlesFrom(Array.from({ length: 200 }, (_, i) => 100 + i * 0.2));
    const down = candlesFrom(Array.from({ length: 200 }, (_, i) => 140 - i * 0.2));
    expect(htfTrend(up, conf.strategy.htf).bullish).toBe(true);
    expect(htfTrend(down, conf.strategy.htf).bullish).toBe(false);
    const always: Strategy = { name: 't', evaluate: () => ({ action: 'buy', score: 0.9, reasons: ['x'], strategy: 't' }) };
    const f = withFilters(always, conf);
    expect(f.evaluate({ candles: up, params: conf.strategy.params }).action).toBe('buy');
    const blocked = f.evaluate({ candles: down, params: conf.strategy.params });
    expect(blocked.action).toBe('hold');
    expect(blocked.score).toBeLessThan(conf.strategy.minBuyScore);
    expect(blocked.reasons[0]).toMatch(/higher-timeframe/);
    // short history: filter stays out of the way
    expect(f.evaluate({ candles: down.slice(0, 20), params: conf.strategy.params }).action).toBe('buy');
  });

  it('computes ATR as a percentage', () => {
    const c = candlesFrom(Array.from({ length: 40 }, (_, i) => (i % 2 ? 100 : 104)));
    const a = atrPct(c, 14)!;
    expect(a).toBeGreaterThan(3);
    expect(a).toBeLessThan(6);
  });
});

describe('market regime', () => {
  const conf = cfg();
  it('is risk-off when SOL dumps in the last hour or sits below its EMA', () => {
    const dump = candlesFrom([...Array.from({ length: 300 }, () => 180), ...Array.from({ length: 61 }, (_, i) => 180 - i * 0.15)]);
    const r = assessRegime(dump, conf, 60);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/down/);
    const below = candlesFrom(Array.from({ length: 400 }, (_, i) => 200 - i * 0.05));
    expect(assessRegime(below, conf, 60).ok).toBe(false);
    const up = candlesFrom(Array.from({ length: 400 }, (_, i) => 150 + i * 0.05));
    expect(assessRegime(up, conf, 60).ok).toBe(true);
  });
  it('passes when disabled or without data', () => {
    expect(assessRegime([], conf, 60).ok).toBe(true);
    expect(assessRegime(candlesFrom([1, 0.5]), cfg({ regime: { enabled: false } }), 60).ok).toBe(true);
  });
});
