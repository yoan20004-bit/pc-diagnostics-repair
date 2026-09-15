import { describe, expect, it } from 'vitest';
import { assessSafety } from '../src/analysis/safety.js';
import { cfg } from './helpers.js';

const f = cfg().scanner.filters;
const goodToken = {
  mint: 'x', symbol: 'GOOD', name: 'Good', decimals: 6, holderCount: 5000, organicScore: 80, isVerified: true, liquidityUsd: 500_000, mcapUsd: 5_000_000,
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
  firstPoolCreatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  stats: { '24h': { buyVolume: 400_000, sellVolume: 350_000 }, '1h': { numBuys: 100, numSells: 90, priceChange: 3 } },
};
const goodMint = { mint: 'x', decimals: 6, supplyRaw: 1_000_000n, mintAuthority: null, freezeAuthority: null, program: 'token' as const };

describe('assessSafety', () => {
  it('passes a healthy token', () => {
    const r = assessSafety({ mint: 'x', token: goodToken, mintInfo: goodMint, holderShare: { topPct: 25, largestPct: 8 } }, f);
    expect(r.ok).toBe(true);
    expect(r.hardFail).toHaveLength(0);
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  it('hard-fails on mint/freeze authority, young age, thin liquidity, and shield rejects', () => {
    const r = assessSafety(
      {
        mint: 'x',
        token: { ...goodToken, liquidityUsd: 1000, firstPoolCreatedAt: new Date().toISOString() },
        mintInfo: { ...goodMint, mintAuthority: 'abc', freezeAuthority: 'def' },
        shieldWarnings: [{ type: 'HAS_MINT_AUTHORITY' }, { type: 'NOT_VERIFIED', severity: 'info' }],
      },
      f,
    );
    expect(r.ok).toBe(false);
    expect(r.hardFail.join(' ')).toMatch(/mint authority/);
    expect(r.hardFail.join(' ')).toMatch(/freeze authority/);
    expect(r.hardFail.join(' ')).toMatch(/liquidity/);
    expect(r.hardFail.join(' ')).toMatch(/age/);
    expect(r.hardFail.join(' ')).toMatch(/shield: HAS_MINT_AUTHORITY/);
  });

  it('rejects Token-2022 with transfer fees and flags buys-without-sells', () => {
    const r = assessSafety({ mint: 'x', token: goodToken, mintInfo: { ...goodMint, program: 'token2022', extensions: ['transferFeeConfig'] } }, { ...f, allowToken2022: true });
    expect(r.hardFail.join(' ')).toMatch(/Token-2022/);
    const hp = assessSafety({ mint: 'x', token: { ...goodToken, stats: { ...goodToken.stats, '1h': { numBuys: 50, numSells: 0 } } }, mintInfo: goodMint }, f);
    expect(hp.hardFail.join(' ')).toMatch(/honeypot/);
  });

  it('lowers the score for concentration and low organic activity without hard failing', () => {
    const r = assessSafety({ mint: 'x', token: { ...goodToken, organicScore: 10, holderCount: 100 }, mintInfo: goodMint, holderShare: { topPct: 70, largestPct: 40 } }, f);
    expect(r.hardFail).toHaveLength(0);
    expect(r.ok).toBe(false);
    expect(r.score).toBeLessThan(50);
  });
});
