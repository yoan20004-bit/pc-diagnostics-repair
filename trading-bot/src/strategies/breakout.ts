import { atr, closes, ema, highest, last } from '../analysis/indicators.js';
import type { Signal } from '../types.js';
import { flowScore, hold, scoreOf, volumeSpike, type Strategy, type StrategyContext } from './base.js';

/**
 * Range breakout: close above the N-bar high with expanding volume and sane volatility.
 */
export class BreakoutStrategy implements Strategy {
  readonly name = 'breakout';

  evaluate(ctx: StrategyContext): Signal {
    const p = ctx.params;
    const c = closes(ctx.candles);
    const need = Math.max(p.breakoutLookback + 3, p.atrPeriod + 2, p.emaSlow + 2);
    if (c.length < need) return hold(this.name, `warming up (${c.length}/${need} candles)`);

    const price = c[c.length - 1];
    const hi = highest(c, p.breakoutLookback, 1) as number;
    const a = last(atr(ctx.candles, p.atrPeriod)) as number;
    const atrPct = price ? (a / price) * 100 : 0;
    const eFast = last(ema(c, p.emaFast)) as number;
    const eSlow = last(ema(c, p.emaSlow)) as number;
    const vol = volumeSpike(ctx.candles);
    const flow = flowScore(ctx);
    const breakoutPct = hi ? ((price - hi) / hi) * 100 : 0;
    const indicators = { price, rangeHigh: hi, breakoutPct, atrPct, emaFast: eFast, emaSlow: eSlow, volSpike: vol, flow };

    if (ctx.position) {
      const reasons: string[] = [];
      const sellScore = scoreOf(
        [
          { w: 3, v: price < eFast && price < hi * 0.98, why: 'failed breakout (back below range high & fast EMA)' },
          { w: 2, v: eFast < eSlow, why: 'fast EMA below slow' },
          { w: 1, v: flow !== undefined && flow < 0.4, why: 'sell flow dominating' },
        ],
        reasons,
      );
      if (sellScore >= 0.5) return { action: 'sell', score: sellScore, reasons, strategy: this.name, indicators };
      return hold(this.name, 'breakout holding', indicators);
    }

    const reasons: string[] = [];
    const fresh = breakoutPct > 0 && breakoutPct < Math.max(3, atrPct * 2); // don't chase extended breaks
    const score = scoreOf(
      [
        { w: 3.5, v: fresh, why: `broke ${p.breakoutLookback}-bar high by ${breakoutPct.toFixed(2)}%` },
        { w: 2, v: vol === undefined ? 0.4 : Math.min(1, vol / p.volumeSpikeMultiplier), why: 'volume spike' },
        { w: 1.5, v: eFast > eSlow, why: 'EMAs aligned bullish' },
        { w: 1, v: atrPct > 0.3 && atrPct < 8, why: 'volatility in tradable range' },
        { w: 1, v: flow === undefined ? 0.5 : Math.min(1, Math.max(0, (flow - 0.45) / 0.2)), why: 'buy flow dominating' },
      ],
      reasons,
    );
    if (!fresh && breakoutPct > 0) reasons.push('breakout already extended');
    return { action: score >= 0.5 && fresh ? 'buy' : 'hold', score: fresh ? score : Math.min(score, 0.4), reasons, strategy: this.name, indicators };
  }
}
