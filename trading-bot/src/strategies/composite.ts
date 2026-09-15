import type { Signal } from '../types.js';
import { BreakoutStrategy } from './breakout.js';
import { MeanReversionStrategy } from './meanReversion.js';
import { MomentumStrategy } from './momentum.js';
import type { Strategy, StrategyContext } from './base.js';

/**
 * Combines the three base strategies with configurable weights. A buy needs the weighted
 * confidence above threshold and at least one strategy firing on its own.
 */
export class CompositeStrategy implements Strategy {
  readonly name = 'composite';
  private subs: { s: Strategy; key: 'momentum' | 'breakout' | 'meanReversion' }[] = [
    { s: new MomentumStrategy(), key: 'momentum' },
    { s: new BreakoutStrategy(), key: 'breakout' },
    { s: new MeanReversionStrategy(), key: 'meanReversion' },
  ];

  evaluate(ctx: StrategyContext): Signal {
    const w = ctx.params.weights;
    const results = this.subs.map(({ s, key }) => ({ key, weight: w[key], sig: s.evaluate(ctx) }));
    const totalW = results.reduce((a, r) => a + r.weight, 0) || 1;
    const indicators: Signal['indicators'] = {};
    for (const r of results) for (const [k, v] of Object.entries(r.sig.indicators ?? {})) indicators[`${r.key}.${k}`] = v;

    if (ctx.position) {
      const sells = results.filter((r) => r.sig.action === 'sell');
      if (!sells.length) return { action: 'hold', score: 0, reasons: ['no exit signal'], strategy: this.name, indicators };
      const score = sells.reduce((a, r) => a + r.weight * r.sig.score, 0) / totalW + Math.max(...sells.map((r) => r.sig.score)) * 0.5;
      return {
        action: 'sell',
        score: Math.min(1, score),
        reasons: sells.flatMap((r) => r.sig.reasons.map((x) => `${r.key}: ${x}`)),
        strategy: this.name,
        indicators,
      };
    }

    const warming = results.filter((r) => r.sig.reasons.some((x) => x.startsWith('warming up')));
    if (warming.length === results.length) return { action: 'hold', score: 0, reasons: [warming[0].sig.reasons[0]], strategy: this.name, indicators };

    const weighted = results.reduce((a, r) => a + r.weight * r.sig.score, 0) / totalW;
    const anyBuy = results.some((r) => r.sig.action === 'buy');
    const best = results.reduce((a, b) => (b.sig.score > a.sig.score ? b : a));
    const score = anyBuy ? Math.min(1, weighted * 0.6 + best.sig.score * 0.4) : Math.min(weighted, 0.45);
    return {
      action: anyBuy && score >= 0.5 ? 'buy' : 'hold',
      score,
      reasons: results.filter((r) => r.sig.action === 'buy').flatMap((r) => r.sig.reasons.map((x) => `${r.key}: ${x}`)),
      strategy: this.name,
      indicators,
    };
  }
}
