import { describe, expect, it } from 'vitest';
import { applyParams, paramsToPatch, tune } from '../src/backtest/tuner.js';
import { candlesFrom, cfg, walk } from './helpers.js';

describe('tuner', () => {
  it('maps params to config and to a patch', () => {
    const c = applyParams(cfg(), { emaFast: 5, stopLossPct: 12, trailPct: 9 });
    expect(c.strategy.params.emaFast).toBe(5);
    expect(c.risk.stopLossPct).toBe(12);
    expect(c.risk.trailingStop.trailPct).toBe(9);
    expect(paramsToPatch({ emaFast: 5, minBuyScore: 0.7, stopAtrMultiple: 3 })).toEqual({ strategy: { params: { emaFast: 5 }, minBuyScore: 0.7 }, risk: { volatility: { stopAtrMultiple: 3 } } });
  });

  it('runs a walk-forward search and ranks by out-of-sample score', async () => {
    const sets = [candlesFrom(walk(500, 1, 0.05, 0.9, 3)), candlesFrom(walk(500, 2, 0.02, 1.1, 9))];
    const r = await tune(sets, cfg(), { grid: { emaFast: [5, 9], stopLossPct: [6, 10] }, minTrades: 1, yieldEvery: 1 });
    expect(r.combosTried).toBe(4);
    expect(r.top.length).toBe(4);
    for (let i = 1; i < r.top.length; i++) expect(r.top[i - 1].score).toBeGreaterThanOrEqual(r.top[i].score);
    expect(r.baseline.test.trades).toBeGreaterThanOrEqual(0);
    if (r.best) expect(r.patch).toBeDefined();
  });

  it('respects the time budget', async () => {
    const r = await tune([candlesFrom(walk(300))], cfg(), { timeBudgetMs: 1, minTrades: 1 });
    expect(r.combosTried).toBeLessThanOrEqual(1);
  });
});
