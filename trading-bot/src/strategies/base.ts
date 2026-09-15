import type { StrategyParams } from '../config.js';
import type { Candle, PairInfo, Position, Signal, TokenMeta } from '../types.js';

export interface StrategyContext {
  candles: Candle[];
  params: StrategyParams;
  pair?: PairInfo;
  token?: TokenMeta;
  position?: Position;
}

export interface Strategy {
  readonly name: string;
  /** Returns a buy/sell/hold signal with a 0..1 confidence. */
  evaluate(ctx: StrategyContext): Signal;
}

export function hold(strategy: string, reason: string, indicators?: Signal['indicators']): Signal {
  return { action: 'hold', score: 0, reasons: [reason], strategy, indicators };
}

/** Weighted sum of boolean/partial conditions -> 0..1 */
export function scoreOf(parts: { w: number; v: number | boolean; why?: string }[], reasons?: string[]): number {
  let total = 0;
  let got = 0;
  for (const p of parts) {
    const v = typeof p.v === 'boolean' ? (p.v ? 1 : 0) : Math.max(0, Math.min(1, p.v));
    total += p.w;
    got += p.w * v;
    if (reasons && p.why && v >= 0.5) reasons.push(p.why);
  }
  return total ? got / total : 0;
}

/** Ratio of buys to sells over the last hour from DexScreener/Jupiter data, if any. */
export function flowScore(ctx: StrategyContext): number | undefined {
  const b = ctx.pair?.txns.h1.buys ?? ctx.token?.stats?.['1h']?.numBuys;
  const s = ctx.pair?.txns.h1.sells ?? ctx.token?.stats?.['1h']?.numSells;
  if (b === undefined || s === undefined || b + s < 10) return undefined;
  return b / (b + s); // 0.5 = balanced
}

export function volumeSpike(candles: Candle[], lookback = 20, recent = 3): number | undefined {
  const withVol = candles.filter((c) => c.v > 0);
  if (withVol.length < lookback + recent) return undefined;
  const base = candles.slice(-(lookback + recent), -recent).reduce((a, c) => a + c.v, 0) / lookback;
  const now = candles.slice(-recent).reduce((a, c) => a + c.v, 0) / recent;
  return base ? now / base : undefined;
}
