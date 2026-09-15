import { describe, expect, it } from 'vitest';
import { RiskManager } from '../src/trading/risk.js';
import { PositionManager } from '../src/trading/positions.js';
import { PaperExecutor } from '../src/trading/executor.js';
import { Store } from '../src/storage/db.js';
import type { Position } from '../src/types.js';
import { cfg } from './helpers.js';

const pos = (extra: Partial<Position> = {}): Position => ({ id: 'p', mint: 'm', symbol: 'T', decimals: 6, amountRaw: '1000', costSol: 1, entryPriceSol: 1, entryPriceUsd: 0, openedAt: 0, highWaterMarkSol: 1, ladderDone: 0, realisedSol: 0, strategy: 't', status: 'open', ...extra });

describe('volatility-scaled stops and sizing', () => {
  const r = new RiskManager(cfg({ risk: { volatility: { stopAtrMultiple: 2.5, minStopPct: 4, maxStopPct: 15, riskPerTradePct: 1 }, positionSizeSol: 1, positionSizePct: 50, maxExposureSol: 5, minSolReserve: 0 } }).risk);
  it('derives the stop from ATR within bounds', () => {
    expect(r.stopPctFor(1)).toBe(4); // 2.5% -> min 4
    expect(r.stopPctFor(3)).toBeCloseTo(7.5);
    expect(r.stopPctFor(20)).toBe(15);
    expect(r.stopPctFor(undefined)).toBe(cfg().risk.stopLossPct);
  });
  it('caps size so a stop-out loses riskPerTradePct', () => {
    // balance 10, 1% risk = 0.1 SOL; stop 8% -> 1.25 cap -> positionSizeSol 1 wins
    expect(r.positionSize(10, 0, 8)).toBeCloseTo(1);
    // stop 15% -> 0.666
    expect(r.positionSize(10, 0, 15)).toBeCloseTo(0.666666, 4);
    expect(new RiskManager(cfg({ risk: { volatility: { enabled: false } } }).risk).positionSize(10, 0, 15)).toBeCloseTo(0.25);
  });
  it('rejects quotes that cannot be sold back', () => {
    expect(r.checkQuote({ roundTripLossPct: 12 }).reason).toMatch(/sell-path/);
    expect(r.checkQuote({ roundTripLossPct: 1.5 }).ok).toBe(true);
  });
});

describe('profit-lock stop', () => {
  const risk = cfg({ risk: { stopLossPct: 10, lockProfitFraction: 0.5, takeProfitLadder: [{ gainPct: 10, sellPct: 50 }, { gainPct: 30, sellPct: 100 }], trailingStop: { enabled: false } } }).risk;
  const pm = new PositionManager(risk, 0.6);
  it('uses the per-position ATR stop and locks half of each banked rung', () => {
    expect(pm.stopLevelPct(pos({ stopPct: 6 }))).toBe(-6);
    expect(pm.checkExit(pos({ stopPct: 6 }), 0.95, undefined, 1)).toBeUndefined();
    expect(pm.checkExit(pos({ stopPct: 6 }), 0.935, undefined, 1)!.reason).toMatch(/stop-loss \(6.0%\)/);
    const p = pos({ ladderDone: 1, highWaterMarkSol: 1.12 });
    expect(pm.stopLevelPct(p)).toBe(5);
    expect(pm.checkExit(p, 1.07, undefined, 1)).toBeUndefined();
    const d = pm.checkExit(p, 1.04, undefined, 1)!;
    expect(d.kind).toBe('stop');
    expect(d.reason).toMatch(/profit-lock stop at \+5.0%/);
  });
});

describe('paper previews and store upgrades', () => {
  it('previews buy and sell with expected prices', async () => {
    const pe = new PaperExecutor(() => 0.001, cfg().execution, undefined, undefined, 5);
    const b = await pe.previewBuy('m', 1);
    expect(b.expectedPriceSol).toBe(0.001);
    expect(b.roundTripLossPct!).toBeGreaterThan(0);
    const s = await pe.previewSell('m', 500n);
    expect(s.expectedSolOut).toBeCloseTo(0.5);
  });
  it('migrates old databases, stores slippage and builds analytics', () => {
    const s = new Store(':memory:');
    s.upsertPosition({ id: 'a', mint: 'm', symbol: 'T', decimals: 6, amountRaw: '1', costSol: 1, entryPriceSol: 1, entryPriceUsd: 1, openedAt: 1, highWaterMarkSol: 1, ladderDone: 0, realisedSol: 0, strategy: 'momentum', status: 'open', stopPct: 7 });
    expect(s.openPositions()[0].stopPct).toBe(7);
    s.insertTrade({ positionId: 'a', mint: 'm', symbol: 'T', side: 'buy', amountRaw: '1', sol: 1, priceSol: 1.02, priceUsd: 1, feeSol: 0, reason: 'r', mode: 'paper', ts: 3_600_000, expectedPriceSol: 1, slippagePct: 2 });
    s.insertTrade({ positionId: 'a', mint: 'm', symbol: 'T', side: 'sell', amountRaw: '1', sol: 1.1, priceSol: 1.1, priceUsd: 1, feeSol: 0, reason: 'tp', mode: 'paper', ts: 7_200_000, pnlSol: 0.1, slippagePct: 4, exitKind: 'takeProfit' });
    const sl = s.slippageStats();
    expect(sl.fills).toBe(2);
    expect(sl.byMint['m'].avgPct).toBe(3);
    const a = s.analytics();
    expect(a.byStrategy[0]).toMatchObject({ key: 'momentum', trades: 1, wins: 1 });
    expect(a.byExitKind[0].key).toBe('takeProfit');
    expect(a.byHour[0].key).toBe('02');
    expect(s.trades()[0].exitKind).toBe('takeProfit');
    s.close();
  });
});
