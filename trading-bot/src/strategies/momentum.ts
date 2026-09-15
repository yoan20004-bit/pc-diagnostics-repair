import { atr, closes, ema, last, macd, rsi, slopePct } from '../analysis/indicators.js';
import type { Signal } from '../types.js';
import { flowScore, hold, scoreOf, volumeSpike, type Strategy, type StrategyContext } from './base.js';

/**
 * Trend-following momentum: EMA alignment + fresh crossover + RSI in a healthy band +
 * MACD histogram expanding + volume/flow confirmation.
 */
export class MomentumStrategy implements Strategy {
  readonly name = 'momentum';

  evaluate(ctx: StrategyContext): Signal {
    const p = ctx.params;
    const c = closes(ctx.candles);
    const need = Math.max(p.emaTrend, p.emaSlow + 3, p.rsiPeriod + 2, 35);
    if (c.length < need) return hold(this.name, `warming up (${c.length}/${need} candles)`);

    const eFast = ema(c, p.emaFast);
    const eSlow = ema(c, p.emaSlow);
    const eTrend = ema(c, p.emaTrend);
    const r = rsi(c, p.rsiPeriod);
    const m = macd(c);
    const price = c[c.length - 1];
    const fast = last(eFast) as number;
    const slow = last(eSlow) as number;
    const trend = last(eTrend) as number;
    const rsiNow = last(r) as number;
    const hist = last(m)?.hist;
    const histPrev = last(m, 1)?.hist;
    const fastSlope = slopePct(eFast, 5) ?? 0;

    // crossover within the last 4 candles
    let crossedUp = false;
    let crossedDown = false;
    for (let i = 1; i <= 4; i++) {
      const f0 = eFast[eFast.length - i] as number | undefined;
      const s0 = eSlow[eSlow.length - i] as number | undefined;
      const f1 = eFast[eFast.length - i - 1] as number | undefined;
      const s1 = eSlow[eSlow.length - i - 1] as number | undefined;
      if (f0 === undefined || s0 === undefined || f1 === undefined || s1 === undefined) break;
      if (f1 <= s1 && f0 > s0) crossedUp = true;
      if (f1 >= s1 && f0 < s0) crossedDown = true;
    }

    const vol = volumeSpike(ctx.candles);
    const flow = flowScore(ctx);
    const atrNow = last(atr(ctx.candles, p.atrPeriod)) ?? 0;
    const atrPct = price ? (atrNow / price) * 100 : 0;
    // trend strength in % terms so micro-crossovers in a flat market do not count
    const spreadPct = slow ? ((fast - slow) / slow) * 100 : 0;
    const aboveTrendPct = trend ? ((price - trend) / trend) * 100 : 0;
    const histPct = price && hist !== undefined ? (hist / price) * 100 : 0;
    const indicators = { price, emaFast: fast, emaSlow: slow, emaTrend: trend, rsi: rsiNow, macdHist: hist, fastSlopePct: fastSlope, spreadPct, atrPct, volSpike: vol, flow };

    // ---- exit logic for an open position ----
    if (ctx.position) {
      const reasons: string[] = [];
      const sellScore = scoreOf(
        [
          { w: 3, v: crossedDown, why: 'EMA bearish crossover' },
          { w: 2, v: fast < slow && fastSlope < 0, why: 'fast EMA below slow and falling' },
          { w: 2, v: rsiNow > p.rsiOverbought && (hist ?? 0) < (histPrev ?? 0), why: 'RSI overbought with fading MACD' },
          { w: 1.5, v: price < trend, why: 'price below trend EMA' },
          { w: 1, v: flow !== undefined && flow < 0.4, why: 'sell flow dominating' },
        ],
        reasons,
      );
      if (sellScore >= 0.45) return { action: 'sell', score: sellScore, reasons, strategy: this.name, indicators };
      return hold(this.name, 'trend intact', indicators);
    }

    // ---- entry logic ----
    const reasons: string[] = [];
    const rsiBand = rsiNow >= p.rsiBuyMin && rsiNow <= p.rsiBuyMax;
    const score = scoreOf(
      [
        { w: 2.5, v: Math.min(1, spreadPct / 0.4), why: `fast EMA ${spreadPct.toFixed(2)}% above slow` },
        { w: 2, v: Math.min(1, aboveTrendPct / 0.6), why: 'price above trend EMA' },
        { w: 2, v: crossedUp && spreadPct > 0.05, why: 'fresh bullish EMA crossover' },
        { w: 1.5, v: rsiBand, why: `RSI ${rsiNow.toFixed(0)} in buy band` },
        { w: 1.5, v: histPct > 0.02 && (hist ?? 0) > (histPrev ?? 0), why: 'MACD histogram rising' },
        { w: 1, v: fastSlope > 0.05, why: 'fast EMA sloping up' },
        { w: 1, v: vol === undefined ? 0.5 : Math.min(1, vol / p.volumeSpikeMultiplier), why: 'volume expanding' },
        { w: 1, v: flow === undefined ? 0.5 : Math.min(1, Math.max(0, (flow - 0.45) / 0.2)), why: 'buy flow dominating' },
      ],
      reasons,
    );
    // never chase: RSI already overbought kills momentum entries; dead markets are not tradeable
    let capped = score;
    if (rsiNow > p.rsiOverbought) {
      capped = Math.min(capped, 0.4);
      reasons.push('RSI overbought (entry capped)');
    }
    if (atrPct < 0.15 || spreadPct <= 0) {
      capped = Math.min(capped, 0.3);
      reasons.push(spreadPct <= 0 ? 'no bullish EMA spread' : `market too quiet (ATR ${atrPct.toFixed(2)}%)`);
    }
    return { action: capped >= 0.5 ? 'buy' : 'hold', score: capped, reasons, strategy: this.name, indicators };
  }
}
