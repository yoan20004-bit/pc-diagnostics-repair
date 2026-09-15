import { PublicKey, type Connection, type ParsedAccountData } from '@solana/web3.js';
import type { BotConfig } from '../config.js';
import type { HolderQuality } from '../types.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Deep holder analysis in three RPC calls:
 *  1. largest token accounts,
 *  2. their owners (parsed token accounts),
 *  3. the owner accounts themselves (to tell wallets from pools/PDAs and to read SOL balances).
 * Pools and program-owned accounts are excluded from concentration. Bundles show up as clusters
 * of near-identical balances; throwaway wallets as holders with almost no SOL.
 */
export async function analyzeHolders(conn: Connection, mint: string, supplyRaw: bigint, cfg: BotConfig['holders']): Promise<HolderQuality> {
  const largest = await conn.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
  const accounts = largest.value.slice(0, cfg.topN);
  if (!accounts.length || supplyRaw === 0n) return { topPctExPools: 0, largestWalletPct: 0, poolAccounts: 0, bundled: 0, freshWallets: 0, walletsAnalysed: 0 };

  const parsed = await conn.getMultipleParsedAccounts(accounts.map((a) => a.address), { commitment: 'confirmed' });
  const owners: { owner: string; amount: bigint }[] = [];
  accounts.forEach((a, i) => {
    const info = (parsed.value[i]?.data as ParsedAccountData | undefined)?.parsed?.info;
    const owner = info?.owner as string | undefined;
    if (owner) owners.push({ owner, amount: BigInt(a.amount) });
  });
  const uniqueOwners = [...new Set(owners.map((o) => o.owner))];
  const ownerAccounts = uniqueOwners.length ? await conn.getMultipleAccountsInfo(uniqueOwners.map((o) => new PublicKey(o)), 'confirmed') : [];
  const isWallet = new Map<string, boolean>();
  const lamports = new Map<string, number>();
  uniqueOwners.forEach((o, i) => {
    const acc = ownerAccounts[i];
    // a wallet is a system-owned, non-executable account (or one that does not exist yet); anything else is a program/PDA (pool, vault, locker)
    const wallet = !acc || (acc.owner.toBase58() === SYSTEM_PROGRAM && !acc.executable);
    isWallet.set(o, wallet);
    lamports.set(o, acc?.lamports ?? 0);
  });

  const wallets = owners.filter((o) => isWallet.get(o.owner));
  const poolAccounts = owners.length - wallets.length;
  const sumWallets = wallets.reduce((a, o) => a + o.amount, 0n);
  const largest1 = wallets.reduce((m, o) => (o.amount > m ? o.amount : m), 0n);
  const pct = (x: bigint) => Number((x * 10000n) / supplyRaw) / 100;

  // bundle signature: clusters of balances within 2% of each other (2+ wallets per cluster count)
  const amounts = wallets.map((o) => Number(o.amount)).sort((a, b) => b - a);
  let bundled = 0;
  let i = 0;
  while (i < amounts.length) {
    let j = i + 1;
    while (j < amounts.length && amounts[i] > 0 && (amounts[i] - amounts[j]) / amounts[i] <= 0.02) j++;
    if (j - i >= 2) bundled += j - i;
    i = j;
  }
  const freshWallets = wallets.filter((o) => (lamports.get(o.owner) ?? 0) < cfg.freshWalletMaxSol * 1e9).length;

  return {
    topPctExPools: pct(sumWallets),
    largestWalletPct: pct(largest1),
    poolAccounts,
    bundled,
    freshWallets,
    walletsAnalysed: wallets.length,
  };
}

/** Pure scoring of a holder profile so it can be unit-tested and reused by the launch lane. */
export function holderPenalties(h: HolderQuality, limits: { maxTopHoldersPct: number; maxBundledHolders: number; maxFreshWallets: number }): { hardFail: string[]; reasons: string[]; penalty: number } {
  const hardFail: string[] = [];
  const reasons: string[] = [];
  let penalty = 0;
  if (h.bundled > limits.maxBundledHolders) hardFail.push(`${h.bundled} top wallets hold near-identical amounts (bundled launch)`);
  else if (h.bundled >= 2) {
    penalty += 10;
    reasons.push(`${h.bundled} wallets with matching balances`);
  }
  if (h.topPctExPools > limits.maxTopHoldersPct) {
    penalty += 20;
    reasons.push(`top wallets (pools excluded) own ${h.topPctExPools.toFixed(1)}%`);
  }
  if (h.largestWalletPct > 20) {
    penalty += 15;
    reasons.push(`one wallet owns ${h.largestWalletPct.toFixed(1)}%`);
  }
  if (h.freshWallets > limits.maxFreshWallets) {
    penalty += 20;
    reasons.push(`${h.freshWallets} of ${h.walletsAnalysed} top wallets hold no SOL (throwaway wallets)`);
  }
  return { hardFail, reasons, penalty };
}
