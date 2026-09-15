import { ConfigSchema, type BotConfig } from '../src/config.js';
import type { Candle } from '../src/types.js';

export function cfg(overrides: Record<string, unknown> = {}): BotConfig {
  return ConfigSchema.parse(overrides);
}

/** Deterministic pseudo-random generator. */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Synthetic candle series from a list of closes (1-minute bars). */
export function candlesFrom(closes: number[], startTs = 1_700_000_000_000, vol = 1000): Candle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: startTs + i * 60_000, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: vol };
  });
}

/** Geometric random walk with drift, per bar. */
export function walk(n: number, start = 1, driftPct = 0, volPct = 0.5, seed = 7): number[] {
  const r = rng(seed);
  const out = [start];
  for (let i = 1; i < n; i++) {
    const shock = (r() - 0.5) * 2 * volPct;
    out.push(out[i - 1] * (1 + (driftPct + shock) / 100));
  }
  return out;
}
