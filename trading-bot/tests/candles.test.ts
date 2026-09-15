import { describe, expect, it } from 'vitest';
import { CandleStore } from '../src/market/candles.js';

describe('CandleStore', () => {
  it('aggregates ticks into fixed buckets and fills gaps', () => {
    const cs = new CandleStore(60_000, 100);
    const t0 = 1_700_000_040_000;
    cs.addTick('m', 10, t0 + 1000);
    cs.addTick('m', 12, t0 + 30_000);
    cs.addTick('m', 9, t0 + 59_000);
    cs.addTick('m', 11, t0 + 3 * 60_000 + 5000); // skips two buckets
    const c = cs.get('m');
    expect(c).toHaveLength(4);
    expect(c[0]).toMatchObject({ o: 10, h: 12, l: 9, c: 9 });
    expect(c[1].c).toBe(9); // gap filled flat
    expect(c[3].o).toBe(11);
    expect(cs.lastPrice('m')).toBe(11);
  });

  it('seeds history without clobbering live candles and trims to max', () => {
    const cs = new CandleStore(60_000, 15);
    const t0 = 1_700_000_040_000;
    cs.addTick('m', 50, t0 + 10 * 60_000);
    cs.seed('m', Array.from({ length: 20 }, (_, i) => ({ t: t0 + i * 60_000, o: i, h: i, l: i, c: i, v: 0 })));
    const c = cs.get('m');
    expect(c).toHaveLength(15); // trimmed to the newest 15 buckets (5..19)
    expect(c[0].t).toBe(t0 + 5 * 60_000);
    expect(c.find((x) => x.t === t0 + 10 * 60_000)!.c).toBe(50); // live candle wins over seeded value 10
    expect(c.at(-1)!.c).toBe(19);
  });

  it('ignores bad prices', () => {
    const cs = new CandleStore(60_000);
    cs.addTick('m', NaN);
    cs.addTick('m', 0);
    expect(cs.has('m')).toBe(false);
  });
});
