import type { Candle } from '../types.js';

/**
 * Builds fixed-interval OHLCV candles from a stream of price ticks and/or seeds
 * them from a historical source. One series per mint.
 */
export class CandleStore {
  private series = new Map<string, Candle[]>();

  constructor(readonly timeframeMs: number, readonly maxCandles = 600) {}

  bucket(ts: number): number {
    return Math.floor(ts / this.timeframeMs) * this.timeframeMs;
  }

  seed(mint: string, candles: Candle[]) {
    const existing = this.series.get(mint) ?? [];
    const merged = new Map<number, Candle>();
    for (const c of candles) merged.set(this.bucket(c.t), { ...c, t: this.bucket(c.t) });
    for (const c of existing) merged.set(c.t, c); // live candles win
    const arr = [...merged.values()].sort((a, b) => a.t - b.t);
    this.series.set(mint, arr.slice(-this.maxCandles));
  }

  addTick(mint: string, price: number, ts = Date.now(), volume = 0) {
    if (!Number.isFinite(price) || price <= 0) return;
    const t = this.bucket(ts);
    const arr = this.series.get(mint) ?? [];
    const last = arr[arr.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      last.c = price;
      last.v += volume;
    } else if (!last || t > last.t) {
      // fill gaps with flat candles so indicators stay time-consistent
      if (last) {
        for (let g = last.t + this.timeframeMs; g < t; g += this.timeframeMs) {
          arr.push({ t: g, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 });
        }
      }
      arr.push({ t, o: price, h: price, l: price, c: price, v: volume });
    }
    if (arr.length > this.maxCandles) arr.splice(0, arr.length - this.maxCandles);
    this.series.set(mint, arr);
  }

  get(mint: string): Candle[] {
    return this.series.get(mint) ?? [];
  }

  has(mint: string) {
    return (this.series.get(mint)?.length ?? 0) > 0;
  }

  remove(mint: string) {
    this.series.delete(mint);
  }

  mints(): string[] {
    return [...this.series.keys()];
  }

  lastPrice(mint: string): number | undefined {
    const arr = this.series.get(mint);
    return arr?.[arr.length - 1]?.c;
  }
}
