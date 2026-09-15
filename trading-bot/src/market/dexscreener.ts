import type { PairInfo } from '../types.js';
import { RateLimiter, fetchJson } from '../utils.js';

const BASE = 'https://api.dexscreener.com';

interface DsPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  boosts?: { active?: number };
  info?: { websites?: { url?: string }[]; socials?: { type?: string; url?: string }[] };
}

interface DsProfile {
  url?: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  description?: string;
  links?: { type?: string; label?: string; url?: string }[];
}

interface DsBoost {
  url?: string;
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
  description?: string;
}

function n(v: unknown): number {
  const x = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(x) ? x : 0;
}

function toPair(p: DsPair): PairInfo {
  const tx = (k: string) => ({ buys: n(p.txns?.[k]?.buys), sells: n(p.txns?.[k]?.sells) });
  return {
    chainId: p.chainId,
    dexId: p.dexId,
    pairAddress: p.pairAddress,
    url: p.url,
    baseToken: p.baseToken,
    quoteToken: p.quoteToken,
    priceUsd: n(p.priceUsd),
    priceNative: n(p.priceNative),
    liquidityUsd: n(p.liquidity?.usd),
    fdv: p.fdv,
    marketCap: p.marketCap,
    pairCreatedAt: p.pairCreatedAt,
    volume: { m5: n(p.volume?.m5), h1: n(p.volume?.h1), h6: n(p.volume?.h6), h24: n(p.volume?.h24) },
    priceChange: { m5: n(p.priceChange?.m5), h1: n(p.priceChange?.h1), h6: n(p.priceChange?.h6), h24: n(p.priceChange?.h24) },
    txns: { m5: tx('m5'), h1: tx('h1'), h6: tx('h6'), h24: tx('h24') },
    boosted: (p.boosts?.active ?? 0) > 0,
    boostsActive: p.boosts?.active ?? 0,
    socials: p.info?.socials?.length ?? 0,
    hasWebsite: (p.info?.websites?.length ?? 0) > 0,
  };
}

export class DexScreenerClient {
  private pairLimiter = new RateLimiter(280); // 300 rpm documented
  private profileLimiter = new RateLimiter(55); // 60 rpm documented

  /** All Solana pairs for a token, sorted by liquidity desc. */
  async getTokenPairs(mint: string): Promise<PairInfo[]> {
    const res = await fetchJson<DsPair[]>(`${BASE}/token-pairs/v1/solana/${mint}`, { limiter: this.pairLimiter });
    return (Array.isArray(res) ? res : []).map(toPair).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  }

  /** Best pair for up to 30 mints at once. */
  async getBestPairs(mints: string[]): Promise<Map<string, PairInfo>> {
    const out = new Map<string, PairInfo>();
    for (let i = 0; i < mints.length; i += 30) {
      const batch = mints.slice(i, i + 30);
      const res = await fetchJson<DsPair[]>(`${BASE}/tokens/v1/solana/${batch.join(',')}`, { limiter: this.pairLimiter });
      for (const raw of Array.isArray(res) ? res : []) {
        const p = toPair(raw);
        const key = batch.includes(p.baseToken.address) ? p.baseToken.address : p.quoteToken.address;
        const prev = out.get(key);
        if (!prev || p.liquidityUsd > prev.liquidityUsd) out.set(key, p);
      }
    }
    return out;
  }

  async search(query: string): Promise<PairInfo[]> {
    const res = await fetchJson<{ pairs?: DsPair[] }>(`${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`, {
      limiter: this.pairLimiter,
    });
    return (res.pairs ?? []).filter((p) => p.chainId === 'solana').map(toPair);
  }

  /** Newest token profiles on DexScreener (teams that just paid for a listing page): a fresh-launch feed. */
  async getLatestSolanaProfiles(): Promise<string[]> {
    const res = await fetchJson<DsProfile[]>(`${BASE}/token-profiles/latest/v1`, { limiter: this.profileLimiter }).catch(() => [] as DsProfile[]);
    return [...new Set((res ?? []).filter((p) => p.chainId === 'solana' && p.tokenAddress).map((p) => p.tokenAddress))];
  }

  /** Token addresses currently boosted on DexScreener (paid promotion = attention, not quality). */
  async getBoostedSolanaTokens(): Promise<string[]> {
    const [latest, top] = await Promise.all([
      fetchJson<DsBoost[]>(`${BASE}/token-boosts/latest/v1`, { limiter: this.profileLimiter }).catch(() => [] as DsBoost[]),
      fetchJson<DsBoost[]>(`${BASE}/token-boosts/top/v1`, { limiter: this.profileLimiter }).catch(() => [] as DsBoost[]),
    ]);
    const set = new Set<string>();
    for (const b of [...(top ?? []), ...(latest ?? [])]) if (b.chainId === 'solana' && b.tokenAddress) set.add(b.tokenAddress);
    return [...set];
  }
}

export function bestPair(pairs: PairInfo[], mint: string): PairInfo | undefined {
  // Prefer pairs where our token is the base and the quote is SOL/USDC, highest liquidity first.
  const preferredQuotes = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);
  const scored = pairs
    .filter((p) => p.baseToken.address === mint || p.quoteToken.address === mint)
    .map((p) => ({ p, s: p.liquidityUsd * (p.baseToken.address === mint && preferredQuotes.has(p.quoteToken.address) ? 1.2 : 1) }))
    .sort((a, b) => b.s - a.s);
  return scored[0]?.p;
}
