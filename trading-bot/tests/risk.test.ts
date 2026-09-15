import { describe, expect, it } from 'vitest';
import { RiskManager } from '../src/trading/risk.js';
import { cfg } from './helpers.js';

const base = cfg().risk;

describe('RiskManager', () => {
  it('sizes positions by the tightest cap', () => {
    const r = new RiskManager({ ...base, positionSizeSol: 1, positionSizePct: 10, maxExposureSol: 2, minSolReserve: 0.1 });
    expect(r.positionSize(5, 0)).toBeCloseTo(0.5); // 10% of 5
    expect(r.positionSize(50, 0)).toBeCloseTo(1); // hard cap
    expect(r.positionSize(50, 1.7)).toBeCloseTo(0.3); // exposure cap
    expect(r.positionSize(0.3, 0)).toBeCloseTo(0.03); // reserve
    expect(r.positionSize(0.1, 0)).toBe(0);
  });

  it('blocks entries when limits are hit', () => {
    const r = new RiskManager({ ...base, maxOpenPositions: 2 });
    r.rollDay(10);
    expect(r.canOpen({ openPositions: 2, exposureSol: 0, balanceSol: 10, mint: 'a' }).ok).toBe(false);
    expect(r.canOpen({ openPositions: 0, exposureSol: 0, balanceSol: 10, mint: 'a' }).ok).toBe(true);
    expect(r.canOpen({ openPositions: 0, exposureSol: base.maxExposureSol, balanceSol: 10, mint: 'a' }).ok).toBe(false);
  });

  it('halts for the day after the daily loss limit', () => {
    const r = new RiskManager({ ...base, maxDailyLossPct: 5 });
    r.rollDay(10);
    r.onExit('a', -0.6, true);
    const res = r.canOpen({ openPositions: 0, exposureSol: 0, balanceSol: 9.4, mint: 'b' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/daily loss/);
    // next day resets
    r.rollDay(9.4, Date.now() + 86_400_000);
    expect(r.state.haltedReason).toBeUndefined();
    expect(r.state.dailyPnlSol).toBe(0);
  });

  it('applies loss-streak and re-entry cooldowns', () => {
    const r = new RiskManager({ ...base, maxConsecutiveLosses: 2, cooldownAfterLossMin: 30, reentryCooldownMin: 60, maxDailyLossPct: 90 });
    r.rollDay(100);
    const now = Date.now();
    r.onExit('a', -0.1, true, now);
    r.onExit('b', -0.1, true, now);
    expect(r.canOpen({ openPositions: 0, exposureSol: 0, balanceSol: 100, mint: 'c', now }).reason).toMatch(/loss streak/);
    expect(r.canOpen({ openPositions: 0, exposureSol: 0, balanceSol: 100, mint: 'c', now: now + 31 * 60_000 }).ok).toBe(true);
    expect(r.canOpen({ openPositions: 0, exposureSol: 0, balanceSol: 100, mint: 'a', now: now + 31 * 60_000 }).reason).toMatch(/re-entry/);
    expect(r.canOpen({ openPositions: 0, exposureSol: 0, balanceSol: 100, mint: 'a', now: now + 61 * 60_000 }).ok).toBe(true);
  });

  it('rejects quotes with too much impact or slippage', () => {
    const r = new RiskManager({ ...base, maxPriceImpactPct: 1, maxSlippageBps: 100 });
    expect(r.checkQuote({ priceImpactPct: 2 }).ok).toBe(false);
    expect(r.checkQuote({ slippageBps: 300 }).ok).toBe(false);
    expect(r.checkQuote({ priceImpactPct: 0.2, slippageBps: 50 }).ok).toBe(true);
  });
});
