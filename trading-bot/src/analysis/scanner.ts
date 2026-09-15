import type { BotConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { bestPair, type DexScreenerClient } from '../market/dexscreener.js';
import { toTokenMeta, type JupiterClient, type JupTokenV2 } from '../market/jupiter.js';
import type { SolanaRpc } from '../rpc.js';
import type { Candidate, LaunchCandidate, TokenMeta } from '../types.js';
import { SOL_MINT, USDC_MINT, shortMint } from '../utils.js';
import { analyzeHolders } from './holders.js';
import { assessSafety } from './safety.js';
import { scoreLaunch } from '../strategies/launch.js';

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

  setConfig(cfg: BotConfig) {
    this.cfg = cfg;
  }

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
      let holderQuality;
      try {
        mintInfo = await this.rpc.getMintInfo(t.mint);
        if (this.cfg.holders.enabled) holderQuality = await analyzeHolders(this.rpc.connection, t.mint, mintInfo.supplyRaw, this.cfg.holders);
        else holderShare = await this.rpc.getTopHolderShare(t.mint, mintInfo.supplyRaw, 10);
      } catch (e) {
        log.debug(`${t.meta.symbol}: on-chain check failed (${(e as Error).message})`);
      }
      const pair = pairs.get(t.mint);
      const safety = assessSafety({ mint: t.mint, token: t.meta, pair, mintInfo, holderShare, holderQuality, holderLimits: this.cfg.holders, shieldWarnings: shield[t.mint] }, f);
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
    out.sort((a, b) => b.safetyScore + rank(b.token) + attention(b.pair, b.token) - (a.safetyScore + rank(a.token) + attention(a.pair, a.token)));
    return out.slice(0, sc.maxCandidates);
  }

  /** Brand-new tokens for the launch lane. Cheap feeds first, then pair data, then on-chain holder analysis. */
  async discoverLaunches(excludeMints: Set<string> = new Set()): Promise<LaunchCandidate[]> {
    const lc = this.cfg.launch;
    const found = new Map<string, JupTokenV2 | undefined>();
    const tasks: Promise<void>[] = [];
    if (lc.sources.includes('jupiter_recent')) tasks.push(this.jup.getRecentTokens().then((l) => l.forEach((t) => found.set(t.id, t))).catch((e) => log.debug('jupiter recent failed:', (e as Error).message)));
    if (lc.sources.includes('jupiter_trending_5m')) tasks.push(this.jup.getCategory('toptrending', '5m', 50).then((l) => l.forEach((t) => found.set(t.id, t))).catch((e) => log.debug('jupiter 5m trending failed:', (e as Error).message)));
    if (lc.sources.includes('dexscreener_profiles')) tasks.push(this.dex.getLatestSolanaProfiles().then((l) => l.forEach((m) => { if (!found.has(m)) found.set(m, undefined); })).catch(() => undefined));
    await Promise.all(tasks);
    for (const m of [...found.keys()]) if (STABLE_OR_BASE.has(m) || excludeMints.has(m) || this.cfg.blacklist.includes(m)) found.delete(m);
    if (!found.size) return [];

    // fill missing metadata for profile-only finds
    const missing = [...found.entries()].filter(([, t]) => !t).map(([m]) => m);
    if (missing.length) for (const t of await this.jup.getTokens(missing.slice(0, 100)).catch(() => [])) found.set(t.id, t);

    // age pre-filter from Jupiter firstPool, then pairs for the rest
    const now = Date.now();
    const pre = [...found.entries()].filter(([, t]) => {
      const created = t?.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : undefined;
      if (created === undefined) return true; // unknown age: let the pair decide
      const age = (now - created) / 60_000;
      return age >= lc.minAgeMinutes && age <= lc.maxAgeMinutes * 1.5;
    });
    const mints = pre.map(([m]) => m).slice(0, 60);
    if (!mints.length) return [];
    const [pairs, shield] = await Promise.all([
      this.dex.getBestPairs(mints).catch(() => new Map()),
      this.jup.shield(mints).catch(() => ({}) as Record<string, { type: string }[]>),
    ]);
    const out: LaunchCandidate[] = [];
    for (const m of mints) {
      const pair = pairs.get(m);
      if (!pair) continue;
      const t = found.get(m);
      const meta = t ? toTokenMeta(t) : undefined;
      const created = pair.pairCreatedAt ?? (t?.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : undefined);
      const ageMinutes = created ? (now - created) / 60_000 : lc.maxAgeMinutes + 1;
      // cheap rejections before spending RPC calls
      const cheap = scoreLaunch({ pair, token: meta, ageMinutes }, lc);
      if (cheap.rejected) {
        log.debug(`launch ${pair.baseToken.symbol}: ${cheap.rejected}`);
        continue;
      }
      let mintInfo;
      let holders;
      try {
        mintInfo = await this.rpc.getMintInfo(m);
        holders = await analyzeHolders(this.rpc.connection, m, mintInfo.supplyRaw, this.cfg.holders);
      } catch (e) {
        log.debug(`launch ${pair.baseToken.symbol}: on-chain check failed (${(e as Error).message})`);
        continue;
      }
      const rejectTypes = new Set(this.cfg.scanner.filters.rejectShieldWarnings.map((x) => x.toUpperCase()));
      const shieldReject = (shield[m] ?? []).map((w) => (w.type || '').toUpperCase()).find((x) => rejectTypes.has(x));
      const sc = scoreLaunch({ pair, token: meta, holders, ageMinutes, mintAuthorityOn: mintInfo.mintAuthority !== null, freezeAuthorityOn: mintInfo.freezeAuthority !== null, shieldReject }, lc);
      out.push({
        mint: m,
        symbol: pair.baseToken.symbol,
        name: pair.baseToken.name,
        decimals: meta?.decimals ?? mintInfo.decimals,
        ageMinutes,
        score: sc.score,
        reasons: sc.reasons,
        rejected: sc.rejected ?? (sc.ok ? undefined : `score ${sc.score.toFixed(2)} < ${lc.minScore}`),
        pair,
        token: meta,
        holders,
        safetyScore: Math.round(sc.score * 100),
        discoveredAt: now,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
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

/** Attention signals: paid boosts, socials, trader growth. Small nudge on top of quality. */
function attention(pair?: import('../types.js').PairInfo, meta?: TokenMeta): number {
  let a = 0;
  if (pair?.boostsActive) a += Math.min(10, pair.boostsActive);
  if (pair?.socials) a += Math.min(6, pair.socials * 2);
  if (pair?.hasWebsite) a += 2;
  const t1 = meta?.stats?.['1h']?.numTraders ?? 0;
  const t6 = meta?.stats?.['6h']?.numTraders ?? 0;
  if (t1 && t6) a += Math.max(-5, Math.min(10, (t1 / (t6 / 6) - 1) * 5)); // traders per hour vs the 6h average
  const hc = meta?.stats?.['1h']?.holderChange ?? 0;
  a += Math.max(-5, Math.min(5, hc));
  return a;
}

function rank(meta?: TokenMeta): number {
  if (!meta) return 0;
  const organic = meta.organicScore ?? 0;
  const traders = meta.stats?.['1h']?.numTraders ?? 0;
  const chg = meta.stats?.['1h']?.priceChange ?? 0;
  return organic * 0.6 + Math.min(traders, 2000) / 50 + Math.max(-20, Math.min(chg, 20));
}
