import { describe, expect, it } from 'vitest';
import { atr, bollinger, ema, macd, rsi, sma, highest, slopePct } from '../src/analysis/indicators.js';
import { candlesFrom } from './helpers.js';

describe('indicators', () => {
  it('sma and ema warm up correctly', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const s = sma(v, 3);
    expect(s[1]).toBeUndefined();
    expect(s[2]).toBeCloseTo(2);
    expect(s[9]).toBeCloseTo(9);
    const e = ema(v, 3);
    expect(e[1]).toBeUndefined();
    expect(e[2]).toBeCloseTo(2);
    expect(e[9]!).toBeGreaterThan(8.5);
  });

  it('rsi is 100 on a pure uptrend and low on a downtrend', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(up, 14).at(-1)).toBeCloseTo(100);
    expect(rsi(down, 14).at(-1)!).toBeLessThan(5);
    expect(rsi(up, 14)[13]).toBeUndefined();
  });

  it('macd histogram turns positive in an accelerating uptrend', () => {
    const v = Array.from({ length: 80 }, (_, i) => 100 + i * i * 0.01);
    const m = macd(v);
    expect(m.at(-1)!.hist!).toBeGreaterThan(0);
  });

  it('bollinger bands contain the mean and pctB is 0..1 inside bands', () => {
    const v = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const b = bollinger(v, 20, 2).at(-1)!;
    expect(b.lower!).toBeLessThan(b.middle!);
    expect(b.upper!).toBeGreaterThan(b.middle!);
    expect(b.pctB!).toBeGreaterThan(-0.5);
    expect(b.pctB!).toBeLessThan(1.5);
  });

  it('atr grows with volatility', () => {
    const calm = candlesFrom(Array.from({ length: 40 }, () => 100));
    const wild = candlesFrom(Array.from({ length: 40 }, (_, i) => (i % 2 ? 100 : 110)));
    expect(atr(wild, 14).at(-1)!).toBeGreaterThan(atr(calm, 14).at(-1)!);
  });

  it('highest excludes the last bar and slope sign follows trend', () => {
    const v = [1, 2, 3, 4, 5, 10];
    expect(highest(v, 5, 1)).toBe(5);
    expect(slopePct([1, 2, 3, 4, 5], 5)!).toBeGreaterThan(0);
    expect(slopePct([5, 4, 3, 2, 1], 5)!).toBeLessThan(0);
  });
});
