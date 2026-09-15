import type { BotConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { bestPair, type DexScreenerClient } from '../market/dexscreener.js';
import { toTokenMeta, type JupiterClient, type JupTokenV2 } from '../market/jupiter.js';
import type { SolanaRpc } from '../rpc.js';
import type { Candidate, TokenMeta } from '../types.js';
import { SOL_MINT, USDC_MINT, shortMint } from '../utils.js';
import { assessSafety } from './safety.js';

const log = createLogger('scanner');

const STABLE_OR_BASE = new Set([
  SOL_MINT,
  USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH
]);

export class TokenScanner {
  private tokenCache = new Map<string, { meta: TokenMeta; at: number }>();

  constructor(
    private cfg: BotConfig,
    private jup: JupiterClient,
    private dex: DexScreenerClient,
    private rpc: SolanaRpc,
  ) {}

  /** Discover, filter and safety-check tradeable tokens. */
  async discover(extraMints: string[] = []): Promise<Candidate[]> {
    const sc = this.cfg.scanner;
    const sources = new Map<string, Set<string>>();
    const add = (mint: string, src: string) => {
      if (!mint || STABLE_OR_BASE.has(mint) || this.cfg.blacklist.includes(mint)) return;
      if (!sources.has(mint)) sources.set(mint, new Set());
      sources.get(mint)!.add(src);
    };
    for (const m of extraMints) add(m, 'watchlist');

    const jupTokens = new Map<string, JupTokenV2>();
    if (sc.enabled) {
      const tasks: Promise<void>[] = [];
      const pull = (cat: 'toptrending' | 'toporganicscore' | 'toptraded', src: string) =>
        this.jup
          .getCategory(cat, sc.interval, 50)
          .then((list) => list.forEach((t) => (jupTokens.set(t.id, t), add(t.id, src))))
          .catch((e) => log.warn(`${src} failed:`, (e as Error).message));
      if (sc.sources.includes('jupiter_toptrending')) tasks.push(pull('toptrending', 'jupiter_toptrending'));
      if (sc.sources.includes('jupiter_toporganic')) tasks.push(pull('toporganicscore', 'jupiter_toporganic'));
      if (sc.sources.includes('jupiter_toptraded')) tasks.push(pull('toptraded', 'jupiter_toptraded'));
      if (sc.sources.includes('dexscreener_boosted')) {
        tasks.push(
          this.dex
            .getBoostedSolanaTokens()
            .then((list) => list.slice(0, 40).forEach((m) => add(m, 'dexscreener_boosted')))
            .catch((e) => log.warn('dexscreener boosted failed:', (e as Error).message)),
        );
      }
      await Promise.all(tasks);
    }

    // Token metadata for anything we don't have yet (watchlist / dexscreener finds)
    const missing = [...sources.keys()].filter((m) => !jupTokens.has(m));
    if (missing.length) {
      try {
        for (const t of await this.jup.getTokens(missing)) jupTokens.set(t.id, t);
      } catch (e) {
        log.warn('token metadata lookup failed:', (e as Error).message);
      }
    }

    // Cheap pre-filter on Jupiter metadata before spending RPC/DexScreener calls
    const f = sc.filters;
    const pre: { mint: string; meta: TokenMeta; src: string[] }[] = [];
    for (const [mint, srcSet] of sources) {
      const raw = jupTokens.get(mint);
      if (!raw) {
        log.debug(`${shortMint(mint)}: no Jupiter metadata, skipping`);
        continue;
      }
      const meta = toTokenMeta(raw);
      this.tokenCache.set(mint, { meta, at: Date.now() });
      const isWatch = srcSet.has('watchlist');
      const liq = meta.liquidityUsd ?? 0;
      const mcap = meta.mcapUsd ?? meta.fdvUsd ?? 0;
      if (!isWatch) {
        if (liq < f.minLiquidityUsd) continue;
        if (mcap && (mcap < f.minMarketCapUsd || mcap > f.maxMarketCapUsd)) continue;
        if ((meta.holderCount ?? 0) < f.minHolders) continue;
        if ((meta.organicScore ?? 0) < f.minOrganicScore) continue;
        const vol = (meta.stats?.['24h']?.buyVolume ?? 0) + (meta.stats?.['24h']?.sellVolume ?? 0);
        if (vol && vol < f.minVolume24hUsd) continue;
      }
      pre.push({ mint, meta, src: [...srcSet] });
    }
    // rank by organic score * activity so we only deep-check the most promising
    pre.sort((a, b) => rank(b.meta) - rank(a.meta));
    const top = pre.slice(0, Math.max(sc.maxCandidates * 2, 10));
    log.info(`scanner: ${sources.size} raw -> ${pre.length} pre-filtered -> deep-checking ${top.length}`);

    // Deep checks: DexScreener pair, shield, on-chain mint + holders
    const mints = top.map((t) => t.mint);
    const [pairs, shield] = await Promise.all([
      this.dex.getBestPairs(mints).catch((e) => (log.warn('dexscreener pairs failed:', (e as Error).message), new Map())),
      this.jup.shield(mints).catch((e) => (log.warn('shield failed:', (e as Error).message), {} as Record<string, never[]>)),
    ]);

    const out: Candidate[] = [];
    for (const t of top) {
      let mintInfo;
      let holderShare;
      try {
        mintInfo = await this.rpc.getMintInfo(t.mint);
        holderShare = await this.rpc.getTopHolderShare(t.mint, mintInfo.supplyRaw, 10);
      } catch (e) {
        log.debug(`${t.meta.symbol}: on-chain check failed (${(e as Error).message})`);
      }
      const pair = pairs.get(t.mint);
      const safety = assessSafety({ mint: t.mint, token: t.meta, pair, mintInfo, holderShare, shieldWarnings: shield[t.mint] }, f);
      if (!safety.ok) {
        log.debug(`${t.meta.symbol} rejected (${safety.score}): ${[...safety.hardFail, ...safety.reasons].join('; ')}`);
        continue;
      }
      out.push({
        mint: t.mint,
        symbol: t.meta.symbol,
        name: t.meta.name,
        decimals: t.meta.decimals || mintInfo?.decimals || 0,
        source: t.src,
        token: t.meta,
        pair,
        safetyScore: safety.score,
        safetyReasons: safety.reasons,
        discoveredAt: Date.now(),
      });
    }
    out.sort((a, b) => b.safetyScore + rank(b.token) - (a.safetyScore + rank(a.token)));
    return out.slice(0, sc.maxCandidates);
  }

  /** Full deep check for a single mint (used by `check` command and watchlist refresh). */
  async inspect(mint: string): Promise<{ candidate?: Candidate; safety: ReturnType<typeof assessSafety>; meta?: TokenMeta; pair?: import('../types.js').PairInfo }> {
    const [tokens, pairs, shield] = await Promise.all([
      this.jup.getTokens([mint]).catch(() => []),
      this.dex.getTokenPairs(mint).catch(() => []),
      this.jup.shield([mint]).catch(() => ({}) as Record<string, never[]>),
    ]);
    const meta = tokens[0] ? toTokenMeta(tokens[0]) : undefined;
    const pair = bestPair(pairs, mint);
    let mintInfo;
    let holderShare;
    try {
      mintInfo = await this.rpc.getMintInfo(mint);
      holderShare = await this.rpc.getTopHolderShare(mint, mintInfo.supplyRaw, 10);
    } catch (e) {
      log.warn(`on-chain check failed: ${(e as Error).message}`);
    }
    const safety = assessSafety({ mint, token: meta, pair, mintInfo, holderShare, shieldWarnings: shield[mint] }, this.cfg.scanner.filters);
    const candidate: Candidate | undefined = safety.ok
      ? {
          mint,
          symbol: meta?.symbol ?? pair?.baseToken.symbol ?? shortMint(mint),
          name: meta?.name ?? pair?.baseToken.name ?? '',
          decimals: meta?.decimals ?? mintInfo?.decimals ?? 0,
          source: ['manual'],
          token: meta,
          pair,
          safetyScore: safety.score,
          safetyReasons: safety.reasons,
          discoveredAt: Date.now(),
        }
      : undefined;
    return { candidate, safety, meta, pair };
  }
}

function rank(meta?: TokenMeta): number {
  if (!meta) return 0;
  const organic = meta.organicScore ?? 0;
  const traders = meta.stats?.['1h']?.numTraders ?? 0;
  const chg = meta.stats?.['1h']?.priceChange ?? 0;
  return organic * 0.6 + Math.min(traders, 2000) / 50 + Math.max(-20, Math.min(chg, 20));
}
