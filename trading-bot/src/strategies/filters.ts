import { atr, closes, ema, last } from '../analysis/indicators.js';
import type { BotConfig } from '../config.js';
import type { Candle, Signal } from '../types.js';
import type { Strategy, StrategyContext } from './base.js';

/** Aggregate base candles into a higher timeframe (n base candles per bar), aligned to bucket boundaries. */
export function aggregateCandles(candles: Candle[], n: number): Candle[] {
  if (n <= 1 || !candles.length) return candles;
  const tf = candles.length > 1 ? candles[1].t - candles[0].t : 60_000;
  const span = tf * n;
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.t / span) * span;
    const cur = out[out.length - 1];
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    } else out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  }
  return out;
}

export interface HtfTrend {
  available: boolean;
  bullish: boolean;
  emaFast?: number;
  emaSlow?: number;
  bars: number;
}

export function htfTrend(candles: Candle[], htf: BotConfig['strategy']['htf']): HtfTrend {
  const agg = aggregateCandles(candles, htf.multiplier);
  const c = closes(agg);
  if (c.length < htf.emaSlow + 2) return { available: false, bullish: true, bars: c.length };
  const f = last(ema(c, htf.emaFast)) as number;
  const s = last(ema(c, htf.emaSlow)) as number;
  return { available: true, bullish: f > s, emaFast: f, emaSlow: s, bars: c.length };
}

/** ATR as % of the last close, used for volatility-scaled stops. */
export function atrPct(candles: Candle[], period: number): number | undefined {
  const a = last(atr(candles, period));
  const price = candles[candles.length - 1]?.c;
  return a !== undefined && price ? (a / price) * 100 : undefined;
}

/**
 * Wraps a strategy with the higher-timeframe confirmation filter so the live bot and the
 * backtester apply exactly the same gate: a buy is only allowed when the higher-timeframe
 * fast EMA sits above the slow EMA.
 */
export function withFilters(strategy: Strategy, cfg: BotConfig): Strategy {
  return {
    name: strategy.name,
    evaluate(ctx: StrategyContext): Signal {
      const sig = strategy.evaluate(ctx);
      if (ctx.position || sig.action !== 'buy' || !cfg.strategy.htf.enabled) return sig;
      const t = htfTrend(ctx.candles, cfg.strategy.htf);
      if (!t.available || t.bullish) {
        if (t.available) sig.reasons.push(`higher-timeframe trend bullish (${cfg.strategy.htf.multiplier}x)`);
        return sig;
      }
      return {
        ...sig,
        action: 'hold',
        score: Math.min(sig.score, cfg.strategy.minBuyScore - 0.05),
        reasons: [`blocked: higher-timeframe trend bearish (${cfg.strategy.htf.multiplier}x candles)`, ...sig.reasons],
      };
    },
  };
}
