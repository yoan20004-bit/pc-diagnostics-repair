import { describe, expect, it } from 'vitest';
import { Store } from '../src/storage/db.js';

describe('Store', () => {
  it('persists positions, trades and kv', () => {
    const s = new Store(':memory:');
    s.upsertPosition({ id: 'a', mint: 'm', symbol: 'T', decimals: 6, amountRaw: '100', costSol: 1, entryPriceSol: 0.01, entryPriceUsd: 1, openedAt: 1, highWaterMarkSol: 0.01, ladderDone: 0, realisedSol: 0, strategy: 't', status: 'open' });
    expect(s.openPositions()).toHaveLength(1);
    s.insertTrade({ positionId: 'a', mint: 'm', symbol: 'T', side: 'buy', amountRaw: '100', sol: 1, priceSol: 0.01, priceUsd: 1, feeSol: 0.001, reason: 'r', mode: 'paper', ts: 1 });
    s.insertTrade({ positionId: 'a', mint: 'm', symbol: 'T', side: 'sell', amountRaw: '100', sol: 1.2, priceSol: 0.012, priceUsd: 1.2, feeSol: 0.001, reason: 'tp', mode: 'paper', ts: 2, pnlSol: 0.2 });
    const p = s.openPositions()[0];
    p.status = 'closed';
    p.closedAt = 2;
    s.upsertPosition(p);
    expect(s.openPositions()).toHaveLength(0);
    expect(s.recentClosedPositions()).toHaveLength(1);
    expect(s.positionPnl('a')).toEqual({ pnlSol: 0.2, costSol: 1 });
    const st = s.stats();
    expect(st.trades).toBe(2);
    expect(st.wins).toBe(1);
    expect(st.pnlSol).toBeCloseTo(0.2);
    s.setJson('k', { a: 1 });
    expect(s.getJson('k')).toEqual({ a: 1 });
    s.close();
  });
});
