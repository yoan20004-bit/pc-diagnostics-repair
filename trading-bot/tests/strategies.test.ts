import { describe, expect, it } from 'vitest';
import { MomentumStrategy } from '../src/strategies/momentum.js';
import { MeanReversionStrategy } from '../src/strategies/meanReversion.js';
import { BreakoutStrategy } from '../src/strategies/breakout.js';
import { CompositeStrategy } from '../src/strategies/composite.js';
import { candlesFrom, cfg } from './helpers.js';

const params = cfg().strategy.params;

describe('strategies', () => {
  it('report warmup on short series', () => {
    const c = candlesFrom([1, 2, 3]);
    for (const s of [new MomentumStrategy(), new MeanReversionStrategy(), new BreakoutStrategy(), new CompositeStrategy()]) {
      const sig = s.evaluate({ candles: c, params });
      expect(sig.action).toBe('hold');
      expect(sig.reasons[0]).toMatch(/warming up/);
    }
  });

  it('momentum buys a fresh crossover in an uptrend and does not buy a downtrend', () => {
    // flat base then a steady rise -> fast EMA crosses slow with RSI in band
    // gentle, slightly choppy rise so RSI stays inside the buy band
    const closes = [...Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 0.3), ...Array.from({ length: 10 }, (_, i) => 100.2 + i * 0.08 - (i % 2) * 0.032)];
    const up = new MomentumStrategy().evaluate({ candles: candlesFrom(closes, undefined, 0), params });
    expect(up.score).toBeGreaterThan(0.5);
    expect(up.action).toBe('buy');
    const down = new MomentumStrategy().evaluate({ candles: candlesFrom(Array.from({ length: 70 }, (_, i) => 100 - i * 0.4)), params });
    expect(down.action).toBe('hold');
  });

  it('momentum flags an exit after a bearish crossover', () => {
    const closes = [...Array.from({ length: 50 }, (_, i) => 100 + i * 0.3), ...Array.from({ length: 12 }, (_, i) => 115 - i * 0.6)];
    const sig = new MomentumStrategy().evaluate({
      candles: candlesFrom(closes),
      params,
      position: { id: 'p', mint: 'm', symbol: 'T', decimals: 6, amountRaw: '1', costSol: 1, entryPriceSol: 1, entryPriceUsd: 1, openedAt: 0, highWaterMarkSol: 1, ladderDone: 0, realisedSol: 0, strategy: 't', status: 'open' },
    });
    expect(sig.action).toBe('sell');
  });

  it('mean reversion buys an oversold dip that starts bouncing', () => {
    const closes = [...Array.from({ length: 50 }, () => 100), ...[99, 97.5, 96, 94.5, 93, 92, 91.5, 92.4]];
    const sig = new MeanReversionStrategy().evaluate({ candles: candlesFrom(closes), params });
    expect(sig.score).toBeGreaterThan(0.5);
  });

  it('breakout buys a close above the range high with volume', () => {
    const closes = [...Array.from({ length: 45 }, (_, i) => 100 + (i % 3) * 0.2), 101.2];
    const c = candlesFrom(closes, undefined, 100);
    c.at(-1)!.v = 800;
    c.at(-2)!.v = 400;
    c.at(-3)!.v = 300;
    const sig = new BreakoutStrategy().evaluate({ candles: c, params });
    expect(sig.action).toBe('buy');
    expect(sig.reasons.join(' ')).toMatch(/broke/);
  });

  it('composite requires at least one sub-strategy to fire', () => {
    const flat = candlesFrom(Array.from({ length: 80 }, (_, i) => 100 + (i % 2) * 0.01));
    const sig = new CompositeStrategy().evaluate({ candles: flat, params });
    expect(sig.action).toBe('hold');
    expect(sig.score).toBeLessThanOrEqual(0.45);
  });
});
