import { describe, expect, it } from 'vitest';
import { parseCandlesCsv, runBacktest } from '../src/backtest/engine.js';
import { createStrategy } from '../src/strategies/registry.js';
import { candlesFrom, cfg, walk } from './helpers.js';

describe('backtest', () => {
  it('runs a strategy over synthetic data and produces consistent metrics', () => {
    const c = cfg();
    const candles = candlesFrom(walk(600, 1, 0.05, 0.8, 3));
    const r = runBacktest(candles, c, createStrategy('composite'), { startingEquity: 10, sizeFraction: 0.5 });
    expect(r.candles).toBe(600);
    expect(r.wins + r.losses).toBe(r.trades.length);
    const pnl = r.trades.reduce((a, t) => a + t.pnlQuote, 0);
    expect(r.finalEquity).toBeCloseTo(10 + pnl, 6);
    expect(r.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    for (const t of r.trades) expect(t.exitTs).toBeGreaterThanOrEqual(t.entryTs);
  });

  it('parses csv with unix seconds or ms', () => {
    const c = parseCandlesCsv('time,open,high,low,close,volume\n1700000000,1,2,0.5,1.5,10\n1700000060000,1.5,2,1,1.8,5');
    expect(c).toHaveLength(2);
    expect(c[0].t).toBe(1_700_000_000_000);
    expect(c[1].c).toBe(1.8);
  });
});
