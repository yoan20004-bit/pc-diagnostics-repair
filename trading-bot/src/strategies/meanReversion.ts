import { bollinger, closes, ema, last, rsi } from '../analysis/indicators.js';
import type { Signal } from '../types.js';
import { flowScore, hold, scoreOf, type Strategy, type StrategyContext } from './base.js';

/**
 * Buys oversold dips inside an intact uptrend and sells back at the mean / overbought.
 */
export class MeanReversionStrategy implements Strategy {
  readonly name = 'meanReversion';

  evaluate(ctx: StrategyContext): Signal {
    const p = ctx.params;
    const c = closes(ctx.candles);
    const need = Math.max(p.bbPeriod + 2, p.rsiPeriod + 2, p.emaTrend);
    if (c.length < need) return hold(this.name, `warming up (${c.length}/${need} candles)`);

    const bb = bollinger(c, p.bbPeriod, p.bbStdDev);
    const r = rsi(c, p.rsiPeriod);
    const eTrend = ema(c, p.emaTrend);
    const price = c[c.length - 1];
    const prev = c[c.length - 2];
    const b = last(bb)!;
    const bPrev = last(bb, 1)!;
    const rsiNow = last(r) as number;
    const rsiPrev = last(r, 1) as number;
    const trend = last(eTrend) as number;
    const flow = flowScore(ctx);
    const indicators = { price, rsi: rsiNow, bbLower: b.lower, bbMiddle: b.middle, bbUpper: b.upper, pctB: b.pctB, emaTrend: trend, flow };

    if (ctx.position) {
      const reasons: string[] = [];
      const sellScore = scoreOf(
        [
          { w: 3, v: rsiNow > p.rsiOverbought, why: 'RSI overbought' },
          { w: 2.5, v: (b.pctB ?? 0) >= 0.95, why: 'price at upper band' },
          { w: 1.5, v: (b.pctB ?? 0) >= 0.5 && (bPrev.pctB ?? 0) < 0.5, why: 'crossed back above mean' },
          { w: 1, v: flow !== undefined && flow < 0.4, why: 'sell flow dominating' },
        ],
        reasons,
      );
      if (sellScore >= 0.5) return { action: 'sell', score: sellScore, reasons, strategy: this.name, indicators };
      return hold(this.name, 'no reversion exit yet', indicators);
    }

    const reasons: string[] = [];
    const wasBelowLower = (bPrev.pctB ?? 1) < 0 || prev <= (bPrev.lower ?? 0);
    const reversalCandle = price > prev && (last(ctx.candles)?.c ?? 0) > (last(ctx.candles)?.o ?? 0);
    const score = scoreOf(
      [
        { w: 3, v: rsiNow < p.rsiOversold || rsiPrev < p.rsiOversold, why: `RSI ${rsiNow.toFixed(0)} oversold` },
        { w: 2.5, v: wasBelowLower || (b.pctB ?? 1) < 0.1, why: 'price at/below lower band' },
        { w: 2, v: reversalCandle && rsiNow > rsiPrev, why: 'reversal candle with RSI turning up' },
        { w: 2, v: price > trend * 0.93, why: 'still within the broader uptrend' },
        { w: 1, v: (b.width ?? 0) > 2, why: 'bands wide enough to profit' },
        { w: 1, v: flow === undefined ? 0.5 : Math.min(1, Math.max(0, (flow - 0.4) / 0.2)), why: 'buyers stepping in' },
      ],
      reasons,
    );
    // a knife falling well below trend is not a dip
    const capped = price < trend * 0.85 ? Math.min(score, 0.35) : score;
    if (price < trend * 0.85) reasons.push('too far below trend (falling knife)');
    return { action: capped >= 0.5 ? 'buy' : 'hold', score: capped, reasons, strategy: this.name, indicators };
  }
}
