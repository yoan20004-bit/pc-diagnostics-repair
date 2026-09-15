import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { scoreLaunch } from '../src/strategies/launch.js';
import { analyzeHolders, holderPenalties } from '../src/analysis/holders.js';
import { parseRaydiumV4Vaults, parseTokenAccountAmount, priceFromVaults } from '../src/market/stream.js';
import { PositionManager } from '../src/trading/positions.js';
import { SOL_MINT } from '../src/utils.js';
import { cfg } from './helpers.js';
import type { PairInfo, Position } from '../src/types.js';

const pair = (o: Partial<PairInfo> = {}): PairInfo => ({
  chainId: 'solana', dexId: 'pumpswap', pairAddress: 'pool', baseToken: { address: 'm', symbol: 'NEW', name: 'New' }, quoteToken: { address: SOL_MINT, symbol: 'SOL', name: 'SOL' },
  priceUsd: 0.001, priceNative: 0, liquidityUsd: 60_000, pairCreatedAt: Date.now() - 20 * 60_000,
  volume: { m5: 25_000, h1: 90_000, h6: 90_000, h24: 90_000 }, priceChange: { m5: 12, h1: 40, h6: 40, h24: 40 },
  txns: { m5: { buys: 80, sells: 45 }, h1: { buys: 300, sells: 200 }, h6: { buys: 300, sells: 200 }, h24: { buys: 300, sells: 200 } },
  socials: 2, hasWebsite: true, boostsActive: 5, ...o,
});
const lc = cfg().launch;

describe('launch scorer', () => {
  it('accepts a healthy early launch and explains why', () => {
    const r = scoreLaunch({ pair: pair(), token: { mint: 'm', symbol: 'NEW', name: 'New', decimals: 6, holderCount: 400, organicScore: 50 }, ageMinutes: 20, holders: { topPctExPools: 18, largestWalletPct: 4, poolAccounts: 1, bundled: 0, freshWallets: 1, walletsAnalysed: 19 } }, lc);
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThan(0.6);
    expect(r.reasons.join(' ')).toMatch(/buy\/sell/);
  });
  it('rejects the classic traps', () => {
    expect(scoreLaunch({ pair: pair(), ageMinutes: 1 }, lc).rejected).toMatch(/too new/);
    expect(scoreLaunch({ pair: pair({ txns: { ...pair().txns, m5: { buys: 40, sells: 0 } } }), ageMinutes: 20 }, lc).rejected).toMatch(/honeypot/);
    expect(scoreLaunch({ pair: pair({ liquidityUsd: 5_000 }), ageMinutes: 20 }, lc).rejected).toMatch(/liquidity/);
    expect(scoreLaunch({ pair: pair({ priceChange: { m5: 150, h1: 0, h6: 0, h24: 0 } }), ageMinutes: 20 }, lc).rejected).toMatch(/already up/);
    expect(scoreLaunch({ pair: pair(), ageMinutes: 20, mintAuthorityOn: true }, lc).rejected).toMatch(/mint authority/);
    expect(scoreLaunch({ pair: pair(), ageMinutes: 20, holders: { topPctExPools: 20, largestWalletPct: 5, poolAccounts: 1, bundled: 6, freshWallets: 0, walletsAnalysed: 19 } }, lc).rejected).toMatch(/bundled/);
    expect(scoreLaunch({ pair: pair(), ageMinutes: 20, shieldReject: 'TRANSFER_TAX' }, lc).rejected).toMatch(/shield/);
  });
  it('penalises weak tape below the threshold', () => {
    const weak = scoreLaunch({ pair: pair({ txns: { ...pair().txns, m5: { buys: 26, sells: 21 } }, volume: { m5: 5_500, h1: 0, h6: 0, h24: 0 }, socials: 0, hasWebsite: false, boostsActive: 0, priceChange: { m5: -3, h1: 0, h6: 0, h24: 0 } }), ageMinutes: 20 }, lc);
    expect(weak.rejected).toBeUndefined();
    expect(weak.ok).toBe(false);
  });
});

describe('holder analysis', () => {
  const owners = Array.from({ length: 8 }, () => Keypair.generate().publicKey);
  const pool = Keypair.generate().publicKey;
  const amounts = [500_000n, 100_000n, 100_000n, 100_000n, 99_500n, 30_000n, 20_000n, 10_000n, 5_000n]; // index 0 = pool
  const tokenAccounts = amounts.map(() => Keypair.generate().publicKey);
  const conn = {
    getTokenLargestAccounts: async () => ({ value: tokenAccounts.map((a, i) => ({ address: a, amount: amounts[i].toString() })) }),
    getMultipleParsedAccounts: async () => ({ value: tokenAccounts.map((_, i) => ({ data: { parsed: { info: { owner: (i === 0 ? pool : owners[i - 1]).toBase58() } } } })) }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (k.equals(pool) ? { owner: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), executable: false, lamports: 1 } : { owner: new PublicKey('11111111111111111111111111111111'), executable: false, lamports: owners.findIndex((o) => o.equals(k)) < 3 ? 100 : 50_000_000 })),
  } as never;
  it('excludes pools, spots bundles and fresh wallets', async () => {
    const h = await analyzeHolders(conn, Keypair.generate().publicKey.toBase58(), 1_000_000n, cfg().holders);
    expect(h.poolAccounts).toBe(1);
    expect(h.walletsAnalysed).toBe(8);
    expect(h.topPctExPools).toBeCloseTo(46.45, 1);
    expect(h.largestWalletPct).toBe(10);
    expect(h.bundled).toBe(4); // three 100k + one 99.5k within 2%
    expect(h.freshWallets).toBe(3);
    const pen = holderPenalties(h, { maxTopHoldersPct: 45, maxBundledHolders: 3, maxFreshWallets: 2 });
    expect(pen.hardFail[0]).toMatch(/bundled/);
    expect(pen.reasons.join(' ')).toMatch(/no SOL/);
  });
});

describe('price stream parsing', () => {
  it('reads token account amounts and Raydium v4 vaults', () => {
    const acc = Buffer.alloc(165);
    acc.writeBigUInt64LE(123456789n, 64);
    expect(parseTokenAccountAmount(acc)).toBe(123456789n);
    const pool = Buffer.alloc(752);
    const bv = Keypair.generate().publicKey;
    const qv = Keypair.generate().publicKey;
    bv.toBuffer().copy(pool, 336);
    qv.toBuffer().copy(pool, 368);
    expect(parseRaydiumV4Vaults(pool)).toEqual({ baseVault: bv.toBase58(), quoteVault: qv.toBase58() });
    expect(parseRaydiumV4Vaults(Buffer.alloc(10))).toBeUndefined();
    expect(priceFromVaults(1_000_000_000n, 2_000_000_000n, 6, 9)).toBeCloseTo(2 / 1000); // 1000 tokens vs 2 SOL
    expect(priceFromVaults(0n, 1n, 6, 9)).toBeUndefined();
  });
});

describe('lane exit profiles', () => {
  it('uses launch exits for launch positions', () => {
    const c = cfg({ launch: { exits: { stopLossPct: 20, maxHoldMinutes: 45, takeProfitLadder: [{ gainPct: 30, sellPct: 50 }, { gainPct: 200, sellPct: 100 }] } } });
    const pm = new PositionManager(c.risk, 0.6, c.launch.exits);
    const p: Position = { id: 'p', mint: 'm', symbol: 'L', decimals: 6, amountRaw: '1', costSol: 1, entryPriceSol: 1, entryPriceUsd: 1, openedAt: 0, highWaterMarkSol: 1, ladderDone: 0, realisedSol: 0, strategy: 'launch', status: 'open', lane: 'launch', stopPct: 20 };
    expect(pm.stopLevelPct(p)).toBe(-20);
    expect(pm.checkExit(p, 0.85, undefined, 1)).toBeUndefined();
    expect(pm.checkExit({ ...p }, 1.31, undefined, 1)!.kind).toBe('takeProfit');
    expect(pm.checkExit({ ...p }, 1.0, undefined, 46 * 60_000)!.kind).toBe('time');
    const core = { ...p, lane: 'core' as const, stopPct: undefined };
    expect(pm.stopLevelPct(core)).toBe(-c.risk.stopLossPct);
  });
});
