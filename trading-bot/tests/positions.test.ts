import { describe, expect, it } from 'vitest';
import { PositionManager } from '../src/trading/positions.js';
import type { Position } from '../src/types.js';
import { cfg } from './helpers.js';

const risk = cfg({
  risk: {
    stopLossPct: 10,
    takeProfitLadder: [
      { gainPct: 10, sellPct: 50 },
      { gainPct: 30, sellPct: 100 },
    ],
    trailingStop: { enabled: true, activationPct: 15, trailPct: 5 },
    maxHoldMinutes: 60,
    lockProfitFraction: 0, // classic breakeven behaviour for these tests; profit-lock is covered in upgrades.test.ts
  },
}).risk;

function pos(entry = 1): Position {
  return { id: 'p', mint: 'm', symbol: 'T', decimals: 6, amountRaw: '1000', costSol: 1, entryPriceSol: entry, entryPriceUsd: 0, openedAt: 0, highWaterMarkSol: entry, ladderDone: 0, realisedSol: 0, strategy: 't', status: 'open' };
}

describe('PositionManager exits', () => {
  const pm = new PositionManager(risk, 0.6);

  it('holds inside the range', () => {
    expect(pm.checkExit(pos(), 1.05, undefined, 1000)).toBeUndefined();
  });

  it('fires the stop-loss', () => {
    const d = pm.checkExit(pos(), 0.89, undefined, 1000)!;
    expect(d.kind).toBe('stop');
    expect(d.sellPct).toBe(100);
  });

  it('walks the take-profit ladder and moves the stop to breakeven', () => {
    const p = pos();
    const d1 = pm.checkExit(p, 1.11, undefined, 1000)!;
    expect(d1.kind).toBe('takeProfit');
    expect(d1.sellPct).toBe(50);
    p.ladderDone = 1;
    // back to slightly below entry -> breakeven stop
    const d2 = pm.checkExit(p, 0.995, undefined, 1000)!;
    expect(d2.kind).toBe('stop');
    expect(d2.reason).toMatch(/breakeven/);
    const d3 = pm.checkExit(pos(), 1.31, undefined, 1000)!;
    expect(d3.kind).toBe('takeProfit'); // price at its own high: no trailing drawdown, first rung fires
  });

  it('trailing stop only after activation, exits on drawdown from high', () => {
    const p = pos();
    p.ladderDone = 2; // ladder exhausted so only trailing applies
    pm.checkExit(p, 1.2, undefined, 1000); // sets hwm to 1.2 (+20% > activation)
    expect(p.highWaterMarkSol).toBeCloseTo(1.2);
    expect(pm.checkExit(p, 1.16, undefined, 1000)).toBeUndefined(); // -3.3% from high
    const d = pm.checkExit(p, 1.13, undefined, 1000)!; // -5.8% from high
    expect(d.kind).toBe('trailing');
  });

  it('time stop and signal exits', () => {
    const p = pos();
    const d = pm.checkExit(p, 1.01, undefined, 61 * 60_000)!;
    expect(d.kind).toBe('time');
    const s = pm.checkExit(pos(), 1.01, { action: 'sell', score: 0.7, reasons: ['x'], strategy: 't' }, 1000)!;
    expect(s.kind).toBe('signal');
    expect(pm.checkExit(pos(), 1.01, { action: 'sell', score: 0.3, reasons: ['x'], strategy: 't' }, 1000)).toBeUndefined();
  });
});
