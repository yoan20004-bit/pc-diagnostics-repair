import type { RiskConfig } from '../config.js';
import type { Position, Signal } from '../types.js';

export interface ExitDecision {
  reason: string;
  /** % of the remaining position to sell (100 = close) */
  sellPct: number;
  kind: 'stop' | 'trailing' | 'takeProfit' | 'time' | 'signal';
}

/**
 * Pure exit rules for open positions. Evaluated in priority order:
 * hard stop -> trailing stop -> take-profit ladder -> max hold time -> strategy sell signal.
 */
export class PositionManager {
  constructor(private cfg: RiskConfig, private minSellScore: number) {}

  setConfig(cfg: RiskConfig, minSellScore: number) {
    this.cfg = cfg;
    this.minSellScore = minSellScore;
  }

  /** Update the high-water mark; returns true if it changed. */
  track(p: Position, priceSol: number): boolean {
    if (priceSol > p.highWaterMarkSol) {
      p.highWaterMarkSol = priceSol;
      return true;
    }
    return false;
  }

  gainPct(p: Position, priceSol: number): number {
    return p.entryPriceSol ? ((priceSol - p.entryPriceSol) / p.entryPriceSol) * 100 : 0;
  }

  checkExit(p: Position, priceSol: number, signal?: Signal, now = Date.now()): ExitDecision | undefined {
    this.track(p, priceSol);
    const gain = this.gainPct(p, priceSol);
    const ladder = this.cfg.takeProfitLadder;

    // 1. hard stop-loss; moves to breakeven once the first TP rung is banked
    const stopPct = p.ladderDone > 0 ? 0 : -this.cfg.stopLossPct;
    if (gain <= stopPct) {
      return { reason: p.ladderDone > 0 ? `breakeven stop hit (${gain.toFixed(2)}%)` : `stop-loss hit (${gain.toFixed(2)}%)`, sellPct: 100, kind: 'stop' };
    }

    // 2. trailing stop
    const ts = this.cfg.trailingStop;
    if (ts.enabled && p.entryPriceSol > 0) {
      const hwmGain = ((p.highWaterMarkSol - p.entryPriceSol) / p.entryPriceSol) * 100;
      if (hwmGain >= ts.activationPct) {
        const drawdown = ((p.highWaterMarkSol - priceSol) / p.highWaterMarkSol) * 100;
        if (drawdown >= ts.trailPct) {
          return { reason: `trailing stop (${drawdown.toFixed(2)}% off high, +${gain.toFixed(2)}% from entry)`, sellPct: 100, kind: 'trailing' };
        }
      }
    }

    // 3. take-profit ladder
    if (p.ladderDone < ladder.length) {
      const rung = ladder[p.ladderDone];
      if (gain >= rung.gainPct) {
        return { reason: `take-profit rung ${p.ladderDone + 1}/${ladder.length} (+${gain.toFixed(2)}%)`, sellPct: rung.sellPct, kind: 'takeProfit' };
      }
    }

    // 4. time stop
    if (now - p.openedAt >= this.cfg.maxHoldMinutes * 60_000) {
      return { reason: `max hold time ${this.cfg.maxHoldMinutes}m reached (${gain.toFixed(2)}%)`, sellPct: 100, kind: 'time' };
    }

    // 5. strategy exit
    if (signal && signal.action === 'sell' && signal.score >= this.minSellScore) {
      return { reason: `signal exit [${signal.score.toFixed(2)}]: ${signal.reasons.slice(0, 3).join('; ')}`, sellPct: 100, kind: 'signal' };
    }
    return undefined;
  }
}
