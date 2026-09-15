import type { BotConfig, RiskConfig } from '../config.js';
import type { Position, Signal } from '../types.js';

/** The subset of exit rules a lane needs. */
export interface ExitProfile {
  stopLossPct: number;
  takeProfitLadder: { gainPct: number; sellPct: number }[];
  trailingStop: { enabled: boolean; activationPct: number; trailPct: number };
  maxHoldMinutes: number;
  lockProfitFraction: number;
}

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
  private launch?: ExitProfile;

  constructor(private cfg: RiskConfig, private minSellScore: number, launch?: BotConfig['launch']['exits']) {
    this.launch = launch;
  }

  setConfig(cfg: RiskConfig, minSellScore: number, launch?: BotConfig['launch']['exits']) {
    this.cfg = cfg;
    this.minSellScore = minSellScore;
    this.launch = launch;
  }

  /** Exit rules that apply to this position (core risk config or the launch lane profile). */
  profile(p: Position): ExitProfile {
    if (p.lane === 'launch' && this.launch) return this.launch;
    return this.cfg;
  }

  /** Update the high-water mark; returns true if it changed. */
  track(p: Position, priceSol: number): boolean {
    if (priceSol > p.highWaterMarkSol) {
      p.highWaterMarkSol = priceSol;
      return true;
    }
    return false;
  }

  /** Current stop as a gain % relative to entry (negative = below entry). */
  stopLevelPct(p: Position): number {
    const pr = this.profile(p);
    if (p.ladderDone > 0) {
      const rung = pr.takeProfitLadder[Math.min(p.ladderDone, pr.takeProfitLadder.length) - 1];
      return rung ? rung.gainPct * pr.lockProfitFraction : 0;
    }
    return -(p.stopPct ?? pr.stopLossPct);
  }

  gainPct(p: Position, priceSol: number): number {
    return p.entryPriceSol ? ((priceSol - p.entryPriceSol) / p.entryPriceSol) * 100 : 0;
  }

  checkExit(p: Position, priceSol: number, signal?: Signal, now = Date.now()): ExitDecision | undefined {
    this.track(p, priceSol);
    const gain = this.gainPct(p, priceSol);
    const pr = this.profile(p);
    const ladder = pr.takeProfitLadder;

    // 1. hard stop-loss (ATR-scaled per position); after a TP rung it becomes a profit-lock stop
    const stopLevel = this.stopLevelPct(p);
    if (gain <= stopLevel) {
      const label = p.ladderDone > 0 ? (stopLevel > 0 ? `profit-lock stop at +${stopLevel.toFixed(1)}%` : 'breakeven stop') : `stop-loss (${(p.stopPct ?? pr.stopLossPct).toFixed(1)}%)`;
      return { reason: `${label} hit (${gain.toFixed(2)}%)`, sellPct: 100, kind: 'stop' };
    }

    // 2. trailing stop
    const ts = pr.trailingStop;
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
    if (now - p.openedAt >= pr.maxHoldMinutes * 60_000) {
      return { reason: `max hold time ${pr.maxHoldMinutes}m reached (${gain.toFixed(2)}%)`, sellPct: 100, kind: 'time' };
    }

    // 5. strategy exit
    if (signal && signal.action === 'sell' && signal.score >= this.minSellScore) {
      return { reason: `signal exit [${signal.score.toFixed(2)}]: ${signal.reasons.slice(0, 3).join('; ')}`, sellPct: 100, kind: 'signal' };
    }
    return undefined;
  }
}
