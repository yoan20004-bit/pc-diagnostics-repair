import type { RiskConfig } from '../config.js';

export interface RiskState {
  day: string;
  dayStartBalanceSol: number;
  dailyPnlSol: number;
  tradesToday: number;
  consecutiveLosses: number;
  lastLossAt: number;
  /** mint -> ts of last sell */
  lastExitByMint: Record<string, number>;
  haltedReason?: string;
}

export interface OpenCheck {
  openPositions: number;
  exposureSol: number;
  balanceSol: number;
  mint: string;
  now?: number;
}

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * Enforces capital and behavioural limits: position sizing, exposure caps, daily loss
 * circuit breaker, loss streak cooldowns and per-token re-entry cooldowns.
 */
export class RiskManager {
  state: RiskState;

  constructor(
    private cfg: RiskConfig,
    initial?: Partial<RiskState>,
    private persist?: (s: RiskState) => void,
  ) {
    this.state = {
      day: dayKey(Date.now()),
      dayStartBalanceSol: 0,
      dailyPnlSol: 0,
      tradesToday: 0,
      consecutiveLosses: 0,
      lastLossAt: 0,
      lastExitByMint: {},
      ...initial,
    };
  }

  /** Roll the daily counters when a new UTC day starts. */
  rollDay(balanceSol: number, now = Date.now()) {
    const d = dayKey(now);
    if (this.state.day !== d || this.state.dayStartBalanceSol === 0) {
      this.state.day = d;
      this.state.dayStartBalanceSol = balanceSol;
      this.state.dailyPnlSol = 0;
      this.state.tradesToday = 0;
      this.state.haltedReason = undefined;
      this.save();
    }
  }

  canOpen(c: OpenCheck): { ok: boolean; reason?: string } {
    const now = c.now ?? Date.now();
    const s = this.state;
    if (s.haltedReason) return { ok: false, reason: `halted: ${s.haltedReason}` };
    if (c.openPositions >= this.cfg.maxOpenPositions) return { ok: false, reason: `max open positions (${this.cfg.maxOpenPositions})` };
    if (s.tradesToday >= this.cfg.maxTradesPerDay) return { ok: false, reason: `max trades per day (${this.cfg.maxTradesPerDay})` };
    if (s.dayStartBalanceSol > 0) {
      const lossPct = (-s.dailyPnlSol / s.dayStartBalanceSol) * 100;
      if (lossPct >= this.cfg.maxDailyLossPct) {
        s.haltedReason = `daily loss ${lossPct.toFixed(2)}% >= ${this.cfg.maxDailyLossPct}%`;
        this.save();
        return { ok: false, reason: s.haltedReason };
      }
    }
    if (s.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      const until = s.lastLossAt + this.cfg.cooldownAfterLossMin * 60_000;
      if (now < until) return { ok: false, reason: `loss streak cooldown (${Math.ceil((until - now) / 60000)}m left)` };
      s.consecutiveLosses = 0; // cooldown served
      this.save();
    }
    const lastExit = s.lastExitByMint[c.mint];
    if (lastExit && now - lastExit < this.cfg.reentryCooldownMin * 60_000) {
      return { ok: false, reason: `re-entry cooldown for ${c.mint.slice(0, 6)}` };
    }
    if (c.exposureSol >= this.cfg.maxExposureSol) return { ok: false, reason: `max exposure ${this.cfg.maxExposureSol} SOL reached` };
    const size = this.positionSize(c.balanceSol, c.exposureSol);
    if (size <= 0) return { ok: false, reason: `insufficient free balance (balance ${c.balanceSol.toFixed(4)}, reserve ${this.cfg.minSolReserve})` };
    return { ok: true };
  }

  /** SOL to spend on a new entry, honouring all caps. */
  positionSize(balanceSol: number, exposureSol: number): number {
    const byPct = (balanceSol * this.cfg.positionSizePct) / 100;
    const byExposure = this.cfg.maxExposureSol - exposureSol;
    const byReserve = balanceSol - this.cfg.minSolReserve;
    const size = Math.min(this.cfg.positionSizeSol, byPct, byExposure, byReserve);
    return size >= 0.005 ? Math.floor(size * 1e6) / 1e6 : 0;
  }

  /** Validate a quote against slippage/impact limits. */
  checkQuote(q: { priceImpactPct?: number; slippageBps?: number }): { ok: boolean; reason?: string } {
    if (q.priceImpactPct !== undefined && q.priceImpactPct > this.cfg.maxPriceImpactPct) {
      return { ok: false, reason: `price impact ${q.priceImpactPct.toFixed(2)}% > ${this.cfg.maxPriceImpactPct}%` };
    }
    if (q.slippageBps !== undefined && q.slippageBps > this.cfg.maxSlippageBps) {
      return { ok: false, reason: `slippage ${q.slippageBps}bps > ${this.cfg.maxSlippageBps}bps` };
    }
    return { ok: true };
  }

  onEntry() {
    this.state.tradesToday += 1;
    this.save();
  }

  onExit(mint: string, pnlSol: number, closedFully: boolean, now = Date.now()) {
    const s = this.state;
    s.dailyPnlSol += pnlSol;
    if (closedFully) {
      s.lastExitByMint[mint] = now;
      if (pnlSol < 0) {
        s.consecutiveLosses += 1;
        s.lastLossAt = now;
      } else s.consecutiveLosses = 0;
    }
    this.save();
  }

  private save() {
    this.persist?.(this.state);
  }
}
