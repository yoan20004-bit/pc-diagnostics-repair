import { EventEmitter } from 'node:events';
import type { BotConfig, EnvConfig } from './config.js';
import { createLogger } from './logger.js';
import { TokenScanner } from './analysis/scanner.js';
import { CandleStore } from './market/candles.js';
import { bestPair, type DexScreenerClient } from './market/dexscreener.js';
import type { GeckoTerminalClient } from './market/geckoterminal.js';
import type { JupiterClient } from './market/jupiter.js';
import type { Notifier } from './notify/telegram.js';
import type { Store } from './storage/db.js';
import type { Strategy } from './strategies/base.js';
import { createStrategy } from './strategies/registry.js';
import { atrPct, withFilters } from './strategies/filters.js';
import { assessRegime } from './analysis/regime.js';
import type { ExitDecision } from './trading/positions.js';
import type { Executor } from './trading/executor.js';
import type { PositionManager } from './trading/positions.js';
import type { RiskManager } from './trading/risk.js';
import type { Candidate, LaunchCandidate, PairInfo, Position, RegimeStatus, Signal } from './types.js';
import type { PriceStream, StreamTick } from './market/stream.js';
import { SOL_MINT, escapeHtml as h, fmtNum, fmtPct, fromRaw, shortMint, sleep, uid } from './utils.js';

const log = createLogger('bot');

export interface BotDeps {
  jup: JupiterClient;
  dex: DexScreenerClient;
  gecko: GeckoTerminalClient;
  scanner: TokenScanner;
  store: Store;
  executor: Executor;
  risk: RiskManager;
  positions: PositionManager;
  strategy: Strategy; // replaced on config reload
  notifier: Notifier;
  walletAddress: string;
  /** optional WebSocket price stream (sub-second ticks for held/tracked tokens) */
  stream?: PriceStream;
}

export interface TrackedView {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  source: string[];
  safetyScore: number;
  safetyReasons: string[];
  priceUsd?: number;
  change1h?: number;
  change24h?: number;
  liquidityUsd?: number;
  mcapUsd?: number;
  volume24h?: number;
  holders?: number;
  organicScore?: number;
  buys1h?: number;
  sells1h?: number;
  candles: number;
  signal?: Signal;
  hasPosition: boolean;
  pairUrl?: string;
}

export interface PositionView extends Position {
  priceSol?: number;
  priceUsd?: number;
  gainPct?: number;
  hwmPct: number;
  valueSol?: number;
  unrealisedSol?: number;
  ageMin: number;
  ladderTotal: number;
  /** current stop as gain % from entry (negative below entry) */
  stopLevelPct: number;
}

export interface BotSnapshot {
  ts: number;
  mode: 'paper' | 'live';
  wallet: string;
  running: boolean;
  paused: boolean;
  tickNo: number;
  lastScan: number;
  nextScanIn: number;
  solUsd: number;
  balanceSol: number;
  exposureSol: number;
  risk: BotDeps['risk']['state'];
  stats: ReturnType<BotDeps['store']['stats']>;
  positions: PositionView[];
  tracked: TrackedView[];
  strategy: string;
  config: BotConfig;
  regime: RegimeStatus;
  slippage: ReturnType<BotDeps['store']['slippageStats']>;
  autoBlacklist: string[];
  feedAgeSec: number;
  launch: { enabled: boolean; candidates: LaunchCandidate[]; open: number; lastScan: number; enteredLastHour: number };
  stream: { enabled: boolean; watching: number; ticksPerMin: number };
}

export class TradingBot extends EventEmitter {
  candles: CandleStore;
  private tracked = new Map<string, Candidate>();
  private pairs = new Map<string, PairInfo>();
  private open = new Map<string, Position>(); // one position per mint
  private sellFailures = new Map<string, number>();
  private seeded = new Set<string>();
  private lastSignals = new Map<string, Signal>();
  private extraWatch = new Set<string>();
  private solUsd = 0;
  private running = false;
  private paused = false;
  private tickNo = 0;
  private lastScan = 0;
  private lastPairRefresh = 0;
  private lastBalance = 0;
  private scanRequested = false;
  private busy: Promise<void> | undefined;
  private strategy: Strategy;
  private regime: RegimeStatus = { ok: true, reason: 'not checked yet', checkedAt: 0 };
  private regimeLogged = '';
  private autoBlacklist: Set<string>;
  private lastPriceOk = Date.now();
  private staleAlerted = false;
  private solSeeded = false;
  private fastTimer: NodeJS.Timeout | undefined;
  private launchCandidates: LaunchCandidate[] = [];
  private lastLaunchScan = 0;
  private launchEntries: number[] = []; // timestamps of launch-lane entries (rate limit)
  private streamTicks: number[] = [];
  private streamExitPending = false;
  private loopDone: Promise<void> | undefined;
  private streamFailedAt = new Map<string, number>();

  constructor(private cfg: BotConfig, private env: EnvConfig, private d: BotDeps) {
    super();
    this.candles = new CandleStore(cfg.loop.candleTimeframeSec * 1000, cfg.loop.maxCandles);
    this.strategy = withFilters(d.strategy, cfg);
    this.autoBlacklist = new Set(d.store.getJson<string[]>('autoBlacklist') ?? []);
    for (const p of this.d.store.openPositions()) this.open.set(p.mint, p);
    d.stream?.on('price', (t: StreamTick) => this.onStreamTick(t));
  }

  /* ------------------------------------------------------------ streaming */
  private onStreamTick(t: StreamTick) {
    const quoteUsd = t.quoteMint === SOL_MINT ? this.solUsd : 1; // SOL or a USD stable quote
    if (!quoteUsd) return;
    const usd = t.priceQuote * quoteUsd;
    this.candles.addTick(t.mint, usd, t.ts);
    this.lastPriceOk = t.ts;
    this.streamTicks.push(t.ts);
    if (this.streamTicks.length > 500) this.streamTicks.splice(0, this.streamTicks.length - 500);
    // held token moved: check exits promptly (coalesced to one check per second)
    if (this.open.has(t.mint) && this.running && !this.streamExitPending) {
      this.streamExitPending = true;
      setTimeout(() => {
        this.streamExitPending = false;
        void this.withLock(() => this.manageExits()).catch((e) => log.debug('stream exit check:', (e as Error).message));
      }, 1000);
    }
  }

  private async syncStream() {
    const st = this.d.stream;
    if (!st || !this.cfg.stream.enabled) return;
    const want = [...new Set([...this.open.keys(), ...this.tracked.keys()])].slice(0, this.cfg.stream.maxSubscriptions);
    for (const m of st.watching) if (!want.includes(m)) await st.unwatch(m);
    for (const m of [...this.streamFailedAt.keys()]) if (!want.includes(m)) this.streamFailedAt.delete(m);
    for (const m of want) {
      if (st.has(m)) continue;
      const retryAt = this.streamFailedAt.get(m);
      if (retryAt && Date.now() < retryAt) continue;
      const pair = this.pairs.get(m) ?? this.tracked.get(m)?.pair;
      const dec = this.decimalsOf(m);
      if (!pair || dec === undefined) continue;
      const quoteDec = pair.quoteToken.address === SOL_MINT ? 9 : 6;
      if (pair.quoteToken.address !== SOL_MINT && !/USD/i.test(pair.quoteToken.symbol)) continue; // only SOL/USD-quoted pools
      try {
        if (await st.watch(m, pair, dec, quoteDec)) this.streamFailedAt.delete(m);
        else this.streamFailedAt.set(m, Date.now() + 10 * 60_000); // pool layout not streamable: retry in 10 minutes
      } catch (e) {
        this.streamFailedAt.set(m, Date.now() + 30_000); // transient RPC error: retry soon
        log.debug(`stream watch ${this.tracked.get(m)?.symbol ?? m}: ${(e as Error).message}`);
      }
    }
  }

  get regimeStatus() {
    return this.regime;
  }

  clearAutoBlacklist(mint?: string) {
    if (mint) this.autoBlacklist.delete(mint);
    else this.autoBlacklist.clear();
    this.d.store.setJson('autoBlacklist', [...this.autoBlacklist]);
    this.emit('state');
  }

  /* ------------------------------------------------------------ panel API */

  get isRunning() {
    return this.running;
  }

  get isPaused() {
    return this.paused;
  }

  get config() {
    return this.cfg;
  }

  decimalsOf(mint: string): number | undefined {
    return this.tracked.get(mint)?.decimals ?? this.open.get(mint)?.decimals;
  }

  /** Pause new entries; exits keep being managed. */
  pause() {
    this.paused = true;
    log.info('entries paused (exits still managed)');
    this.emit('state');
  }

  resume() {
    this.paused = false;
    this.d.risk.resume();
    log.info('entries resumed');
    this.emit('state');
  }

  requestScan() {
    this.scanRequested = true;
  }

  addWatch(mint: string) {
    this.extraWatch.add(mint);
    this.scanRequested = true;
  }

  removeTracked(mint: string) {
    this.extraWatch.delete(mint);
    if (!this.open.has(mint)) {
      this.tracked.delete(mint);
      this.candles.remove(mint);
      this.lastSignals.delete(mint);
    }
  }

  /** Apply a new config without restarting (candle timeframe changes need a restart). */
  updateConfig(next: BotConfig) {
    this.cfg = next;
    this.d.risk.setConfig(next.risk);
    this.d.positions.setConfig(next.risk, next.strategy.minSellScore, next.launch.exits);
    this.d.scanner.setConfig(next);
    if (this.d.strategy.name !== next.strategy.name) this.d.strategy = createStrategy(next.strategy.name);
    this.strategy = withFilters(this.d.strategy, next);
    this.candles = Object.assign(this.candles, { maxCandles: next.loop.maxCandles });
    this.startFastLoop();
    log.info('config reloaded');
    this.emit('state');
  }

  /** Close (or partially close) a position from the panel. */
  async closePosition(mint: string, sellPct = 100): Promise<void> {
    const p = this.open.get(mint);
    if (!p) throw new Error('no open position for that mint');
    await this.withLock(() => this.exit(p, sellPct, `manual: panel sell ${sellPct}%`, false));
  }

  /** Manual entry from the panel. Safety screen is consulted but not enforced. */
  async manualBuy(mint: string, sizeSol: number): Promise<string> {
    if (this.open.has(mint)) throw new Error('already holding that token');
    let c = this.tracked.get(mint);
    if (!c) {
      const r = await this.d.scanner.inspect(mint);
      if (!r.candidate && !r.meta && !r.pair) throw new Error('token not found');
      c = r.candidate ?? {
        mint,
        symbol: r.meta?.symbol ?? r.pair?.baseToken.symbol ?? mint.slice(0, 6),
        name: r.meta?.name ?? '',
        decimals: r.meta?.decimals ?? 0,
        source: ['manual'],
        token: r.meta,
        pair: r.pair,
        safetyScore: r.safety.score,
        safetyReasons: [...r.safety.hardFail, ...r.safety.reasons],
        discoveredAt: Date.now(),
      };
      if (!c.decimals) throw new Error('could not determine token decimals');
      this.tracked.set(mint, c);
      if (c.pair) this.pairs.set(mint, c.pair);
      this.extraWatch.add(mint);
      await this.refreshPrices([mint], Date.now());
    }
    const cand = c;
    const sig: Signal = { action: 'buy', score: 1, reasons: ['manual order from panel'], strategy: 'manual' };
    let spent = 0;
    await this.withLock(async () => {
      spent = await this.enter(cand, sig, sizeSol);
    });
    if (!spent) throw new Error('buy did not fill (see log)');
    return cand.symbol;
  }

  snapshot(): BotSnapshot {
    const now = Date.now();
    const positions: PositionView[] = [...this.open.values()].map((p) => {
      const priceSol = this.priceSolPerRaw(p.mint, p.decimals);
      const held = Number(BigInt(p.amountRaw));
      const valueSol = priceSol ? priceSol * held : undefined;
      return {
        ...p,
        priceSol,
        priceUsd: priceSol ? priceSol * this.solUsd * 10 ** p.decimals : undefined,
        gainPct: priceSol ? this.d.positions.gainPct(p, priceSol) : undefined,
        hwmPct: p.entryPriceSol ? ((p.highWaterMarkSol - p.entryPriceSol) / p.entryPriceSol) * 100 : 0,
        valueSol,
        unrealisedSol: valueSol !== undefined ? valueSol - p.costSol : undefined,
        ageMin: Math.round((now - p.openedAt) / 60000),
        ladderTotal: this.cfg.risk.takeProfitLadder.length,
        stopLevelPct: this.d.positions.stopLevelPct(p),
      };
    });
    const tracked: TrackedView[] = [...this.tracked.values()].map((c) => {
      const pair = this.pairs.get(c.mint) ?? c.pair;
      const t = c.token;
      return {
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        decimals: c.decimals,
        source: c.source,
        safetyScore: c.safetyScore,
        safetyReasons: c.safetyReasons,
        priceUsd: this.candles.lastPrice(c.mint) ?? t?.usdPrice ?? pair?.priceUsd,
        change1h: pair?.priceChange.h1 ?? t?.stats?.['1h']?.priceChange,
        change24h: pair?.priceChange.h24 ?? t?.stats?.['24h']?.priceChange,
        liquidityUsd: pair?.liquidityUsd ?? t?.liquidityUsd,
        mcapUsd: t?.mcapUsd ?? pair?.marketCap,
        volume24h: pair?.volume.h24,
        holders: t?.holderCount,
        organicScore: t?.organicScore,
        buys1h: pair?.txns.h1.buys,
        sells1h: pair?.txns.h1.sells,
        candles: this.candles.get(c.mint).length,
        signal: this.lastSignals.get(c.mint),
        hasPosition: this.open.has(c.mint),
        pairUrl: pair?.url,
      };
    });
    tracked.sort((a, b) => Number(b.hasPosition) - Number(a.hasPosition) || (b.signal?.score ?? 0) - (a.signal?.score ?? 0));
    const scanMs = this.cfg.loop.scanIntervalSec * 1000;
    return {
      ts: now,
      mode: this.d.executor.mode,
      wallet: this.d.walletAddress,
      running: this.running,
      paused: this.paused,
      tickNo: this.tickNo,
      lastScan: this.lastScan,
      nextScanIn: Math.max(0, Math.round((this.lastScan + scanMs - now) / 1000)),
      solUsd: this.solUsd,
      balanceSol: this.lastBalance,
      exposureSol: [...this.open.values()].reduce((a, p) => a + p.costSol, 0),
      risk: this.d.risk.state,
      stats: this.d.store.stats(),
      positions,
      tracked,
      strategy: this.d.strategy.name,
      config: this.cfg,
      regime: this.regime,
      slippage: this.d.store.slippageStats(),
      autoBlacklist: [...this.autoBlacklist],
      feedAgeSec: Math.round((now - this.lastPriceOk) / 1000),
      launch: {
        enabled: this.cfg.launch.enabled,
        candidates: this.launchCandidates.slice(0, 20),
        open: [...this.open.values()].filter((p) => p.lane === 'launch').length,
        lastScan: this.lastLaunchScan,
        enteredLastHour: this.launchEntries.filter((t) => now - t < 3_600_000).length,
      },
      stream: {
        enabled: Boolean(this.d.stream) && this.cfg.stream.enabled,
        watching: this.d.stream?.watching.length ?? 0,
        ticksPerMin: this.streamTicks.filter((t) => now - t < 60_000).length,
      },
    };
  }

  /** Serialise panel-triggered trades against the tick loop. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this.busy) await this.busy;
    let release!: () => void;
    this.busy = new Promise<void>((r) => (release = r));
    try {
      return await fn();
    } finally {
      this.busy = undefined;
      release();
    }
  }

  /** SOL per raw token unit (what executors and positions use). */
  priceSolPerRaw(mint: string, decimals: number): number | undefined {
    const usd = this.candles.lastPrice(mint);
    if (!usd || !this.solUsd) return undefined;
    return usd / this.solUsd / 10 ** decimals;
  }

  get openPositions(): Position[] {
    return [...this.open.values()];
  }

  private starting = false;

  async start() {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      if (this.loopDone) await this.loopDone; // a previous loop may still be finishing its last iteration
      if (this.running) return;
      let finish!: () => void;
      this.loopDone = new Promise<void>((r) => (finish = r));
      try {
        await this.runLoop();
      } catch (e) {
        this.running = false; // a failed start must not leave the bot reporting 'running' with no loop
        log.error('bot loop failed to start:', (e as Error).message);
        throw e;
      } finally {
        this.loopDone = undefined;
        finish();
        this.emit('state');
      }
    } finally {
      this.starting = false;
    }
  }

  private async runLoop() {
    this.running = true;
    this.emit('state');
    const balance = await this.d.executor.solBalance();
    this.lastBalance = balance;
    this.d.risk.rollDay(balance);
    log.info(`mode=${this.d.executor.mode} wallet=${this.d.walletAddress} balance=${balance.toFixed(4)} SOL strategy=${this.d.strategy.name} open=${this.open.size}`);
    await this.d.notifier.send(`🤖 <b>Bot started</b> (${this.d.executor.mode})\nWallet: <code>${this.d.walletAddress}</code>\nBalance: ${balance.toFixed(4)} SOL\nOpen positions: ${this.open.size}`);

    // make sure positions restored from disk are tracked with pair + candles
    for (const p of this.open.values()) {
      if (this.tracked.has(p.mint)) continue;
      try {
        const pairs = await this.d.dex.getTokenPairs(p.mint);
        const pair = bestPair(pairs, p.mint);
        if (pair) this.pairs.set(p.mint, pair);
        this.tracked.set(p.mint, { mint: p.mint, symbol: p.symbol, name: p.symbol, decimals: p.decimals, source: ['position'], pair, safetyScore: 0, safetyReasons: [], discoveredAt: Date.now() });
      } catch (e) {
        log.warn(`could not load pair for ${p.symbol}: ${(e as Error).message}`);
      }
    }

    this.startFastLoop();
    while (this.running) {
      const started = Date.now();
      try {
        await this.withLock(() => this.tick());
      } catch (e) {
        log.error('tick failed:', (e as Error).message);
      }
      this.emit('state');
      const elapsed = Date.now() - started;
      const wait = Math.max(1000, this.cfg.loop.pollIntervalSec * 1000 - elapsed);
      for (let waited = 0; waited < wait && this.running && !this.scanRequested; waited += 500) await sleep(500);
    }
    log.info('bot loop stopped');
    if (this.fastTimer) clearInterval(this.fastTimer);
    await this.d.stream?.close().catch(() => undefined);
    this.fastTimer = undefined;
    this.emit('state');
  }

  stop() {
    this.running = false;
  }

  /** Extra, cheaper loop: refresh only held tokens and check exits, so stops fire quickly. */
  private startFastLoop() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    this.fastTimer = undefined;
    const every = this.cfg.loop.fastExitIntervalSec;
    if (!every || !this.running) return;
    this.fastTimer = setInterval(() => {
      if (!this.running || !this.open.size || this.busy) return;
      void this.withLock(async () => {
        await this.refreshPrices([...this.open.keys()], Date.now());
        await this.manageExits();
      }).catch((e) => log.debug('fast exit loop:', (e as Error).message));
    }, every * 1000);
  }

  async tick() {
    this.tickNo++;
    const now = Date.now();
    if (this.scanRequested || now - this.lastScan >= this.cfg.loop.scanIntervalSec * 1000) {
      this.scanRequested = false;
      await this.scan();
    }

    const mints = [...new Set([...this.tracked.keys(), ...this.open.keys()])];
    if (!mints.length) {
      log.info('nothing to track yet (empty watchlist and scanner found no candidates)');
      return;
    }
    await this.refreshPrices(mints, now);
    this.watchFeed(now);
    this.regime = assessRegime(this.candles.get(SOL_MINT), this.cfg, this.cfg.loop.candleTimeframeSec, now);
    const regimeKey = this.regime.ok ? 'ok' : `off:${this.regime.reason.replace(/[\d.$%-]+/g, '#')}`; // log on flips, not on every number change
    if (regimeKey !== this.regimeLogged) {
      this.regimeLogged = regimeKey;
      (this.regime.ok ? log.info : log.warn)(`market regime ${this.regime.ok ? 'OK' : 'RISK-OFF'}: ${this.regime.reason}`);
    }
    if (now - this.lastPairRefresh >= 60_000) {
      this.lastPairRefresh = now;
      try {
        const fresh = await this.d.dex.getBestPairs(mints);
        for (const [m, p] of fresh) this.pairs.set(m, p);
      } catch (e) {
        log.debug('pair refresh failed:', (e as Error).message);
      }
    }
    await this.manageExits();
    await this.manageEntries();
    if (this.cfg.launch.enabled && now - this.lastLaunchScan >= this.cfg.launch.scanIntervalSec * 1000) await this.manageLaunchLane();
    await this.syncStream();
    if (this.tickNo % 4 === 1) await this.logStatus();
  }

  /* ------------------------------------------------------------ launch lane */
  private async manageLaunchLane() {
    this.lastLaunchScan = Date.now();
    const lc = this.cfg.launch;
    try {
      this.launchCandidates = await this.d.scanner.discoverLaunches(new Set([...this.open.keys(), ...this.autoBlacklist]));
    } catch (e) {
      log.warn('launch scan failed:', (e as Error).message);
      return;
    }
    const ok = this.launchCandidates.filter((c) => !c.rejected);
    log.info(`launch lane: ${this.launchCandidates.length} fresh tokens checked, ${ok.length} pass (${ok.map((c) => `${c.symbol} ${c.score.toFixed(2)}`).join(', ') || 'none'})`);
    if (this.paused || !this.regime.ok) return;
    const openLaunch = [...this.open.values()].filter((p) => p.lane === 'launch').length;
    const now = Date.now();
    this.launchEntries = this.launchEntries.filter((t) => now - t < 3_600_000);
    let slots = Math.min(lc.maxOpen - openLaunch, lc.maxPerHour - this.launchEntries.length);
    if (slots <= 0) return;
    const balance = await this.d.executor.solBalance();
    for (const c of ok) {
      if (slots <= 0) break;
      const check = this.d.risk.canOpen({ openPositions: this.open.size, exposureSol: [...this.open.values()].reduce((a, p) => a + p.costSol, 0), balanceSol: balance, mint: c.mint });
      if (!check.ok) {
        log.info(`launch skip ${c.symbol}: ${check.reason}`);
        if (!check.reason?.startsWith('re-entry')) break;
        continue;
      }
      const size = Math.min(lc.sizeSol, Math.max(0, balance - this.cfg.risk.minSolReserve));
      if (size < 0.005) break;
      const cand: Candidate = { mint: c.mint, symbol: c.symbol, name: c.name, decimals: c.decimals, source: ['launch'], token: c.token, pair: c.pair, safetyScore: c.safetyScore, safetyReasons: c.reasons, discoveredAt: c.discoveredAt };
      this.tracked.set(c.mint, cand);
      this.pairs.set(c.mint, c.pair);
      if (c.pair.priceUsd) this.candles.addTick(c.mint, c.pair.priceUsd, now);
      const sig: Signal = { action: 'buy', score: c.score, reasons: c.reasons, strategy: 'launch' };
      const spent = await this.enter(cand, sig, size, lc.exits.stopLossPct, 'launch');
      if (spent > 0) {
        slots--;
        this.launchEntries.push(Date.now());
      }
    }
  }

  /** Scan immediately (panel button). Safe to call while the loop is stopped. */
  async scanNow() {
    await this.withLock(() => this.scan());
    this.emit('state');
  }

  private async refreshPrices(mints: string[], now: number) {
    let prices: Awaited<ReturnType<BotDeps['jup']['getPrices']>>;
    try {
      prices = await this.d.jup.getPrices([SOL_MINT, ...mints]);
    } catch (e) {
      log.warn(`price refresh failed: ${(e as Error).message}`);
      return;
    }
    if (prices[SOL_MINT]) {
      this.solUsd = prices[SOL_MINT].usdPrice;
      this.candles.addTick(SOL_MINT, this.solUsd, now);
      this.lastPriceOk = now;
      if (this.staleAlerted) {
        this.staleAlerted = false;
        log.info('price feed recovered');
      }
    }
    for (const m of mints) {
      const p = prices[m];
      if (p) this.candles.addTick(m, p.usdPrice, now);
      else log.debug(`no price for ${shortMint(m)}`);
    }
  }

  /** Alert once when prices stop arriving; exits cannot be managed without a feed. */
  private watchFeed(now: number) {
    const age = (now - this.lastPriceOk) / 1000;
    if (age >= this.cfg.loop.staleFeedAlertSec && !this.staleAlerted) {
      this.staleAlerted = true;
      log.error(`price feed stale for ${Math.round(age)}s (RPC/Jupiter down or rate limited); open positions are unprotected until it recovers`);
      void this.d.notifier.send(`⚠️ <b>Price feed stale</b> for ${Math.round(age)}s. Open positions cannot be managed until it recovers.`);
    }
  }

  async scan() {
    this.lastScan = Date.now();
    let candidates: Candidate[] = [];
    try {
      candidates = await this.d.scanner.discover([...new Set([...this.cfg.watchlist, ...this.extraWatch])]);
    } catch (e) {
      log.warn('scan failed:', (e as Error).message);
      return;
    }
    const next = new Map<string, Candidate>();
    for (const c of candidates) next.set(c.mint, c);
    for (const [m, c] of this.tracked) if ((this.open.has(m) || this.extraWatch.has(m)) && !next.has(m)) next.set(m, c); // never drop held/pinned tokens
    const added = [...next.keys()].filter((m) => !this.tracked.has(m));
    const dropped = [...this.tracked.keys()].filter((m) => !next.has(m));
    this.tracked = next;
    for (const c of candidates) if (c.pair) this.pairs.set(c.mint, c.pair);
    for (const m of dropped) {
      this.candles.remove(m);
      this.seeded.delete(m);
      this.lastSignals.delete(m);
    }
    if (added.length || dropped.length) {
      log.info(`tracking ${this.tracked.size} tokens: ${[...this.tracked.values()].map((c) => c.symbol).join(', ')}` + (dropped.length ? ` (dropped ${dropped.length})` : ''));
    }
    if (!this.solSeeded && this.cfg.regime.enabled) {
      this.solSeeded = true;
      try {
        const hist = await this.d.gecko.getOhlcv(this.cfg.regime.solPool, this.cfg.loop.candleTimeframeSec, this.cfg.loop.maxCandles);
        if (hist.length) this.candles.seed(SOL_MINT, hist);
      } catch (e) {
        log.debug(`SOL candle seed failed: ${(e as Error).message}`);
      }
    }
    // bootstrap candle history so strategies can act right away
    for (const m of [...next.keys()]) {
      if (this.seeded.has(m)) continue;
      const pair = this.pairs.get(m) ?? next.get(m)?.pair;
      if (!pair) continue;
      try {
        const hist = await this.d.gecko.getOhlcv(pair.pairAddress, this.cfg.loop.candleTimeframeSec, this.cfg.loop.maxCandles);
        if (hist.length) {
          this.candles.seed(m, hist);
          log.debug(`seeded ${hist.length} candles for ${next.get(m)?.symbol}`);
        }
      } catch (e) {
        log.debug(`candle seed failed for ${next.get(m)?.symbol}: ${(e as Error).message}`);
      }
      this.seeded.add(m);
    }
  }

  private signalFor(mint: string, position?: Position): Signal {
    const c = this.tracked.get(mint);
    return this.strategy.evaluate({
      candles: this.candles.get(mint),
      params: this.cfg.strategy.params,
      pair: this.pairs.get(mint),
      token: c?.token,
      position,
    });
  }

  /* ---------------------------------------------------------------- exits */
  private async manageExits() {
    for (const p of [...this.open.values()]) {
      const price = this.priceSolPerRaw(p.mint, p.decimals);
      if (!price) continue;
      const sig = this.candles.get(p.mint).length >= this.cfg.loop.warmupCandles ? this.signalFor(p.mint, p) : undefined;
      if (sig) this.lastSignals.set(p.mint, sig);
      const decision = this.d.positions.checkExit(p, price, sig);
      this.d.store.upsertPosition(p); // persist high-water mark
      if (!decision) continue;
      const failures = this.sellFailures.get(p.id) ?? 0;
      if (failures > 0 && this.tickNo % Math.min(2 ** failures, 16) !== 0) continue; // back off after failures
      await this.exit(p, decision.sellPct, `${decision.kind}: ${decision.reason}`, decision.kind === 'takeProfit', decision.kind);
    }
  }

  private async exit(p: Position, sellPct: number, reason: string, isLadderRung: boolean, exitKind: ExitDecision['kind'] | 'manual' = 'manual') {
    const held = this.d.executor.mode === 'live' ? await this.d.executor.tokenBalance(p.mint).catch(() => BigInt(p.amountRaw)) : BigInt(p.amountRaw);
    const total = held > 0n ? held : BigInt(p.amountRaw);
    const amount = sellPct >= 100 ? total : (total * BigInt(Math.round(sellPct * 100))) / 10000n;
    if (amount <= 0n) {
      log.warn(`${p.symbol}: nothing to sell (balance 0) - closing position record`);
      this.closeRecord(p, 'empty balance');
      return;
    }
    const fraction = Number(amount) / Number(total);
    log.info(`SELL ${p.symbol} ${sellPct}% (${fromRaw(amount, p.decimals).toFixed(4)} tokens) - ${reason}`);
    try {
      const expected = await this.d.executor.previewSell(p.mint, amount).catch(() => undefined);
      const fill = await this.d.executor.sell(p.mint, p.decimals, amount);
      const received = fromRaw(fill.outputAmountRaw, 9);
      const slippagePct = expected?.expectedSolOut ? ((expected.expectedSolOut - received) / expected.expectedSolOut) * 100 : undefined;
      const costPart = p.costSol * fraction;
      const pnl = received - costPart;
      const closedFully = sellPct >= 100 || total - amount <= 0n;
      p.amountRaw = (total - amount).toString();
      p.costSol -= costPart;
      p.realisedSol += received;
      if (isLadderRung) p.ladderDone += 1;
      if (closedFully) {
        p.status = 'closed';
        p.closedAt = Date.now();
        p.closeReason = reason;
        this.open.delete(p.mint);
      }
      this.d.store.upsertPosition(p);
      this.d.store.insertTrade({
        positionId: p.id, mint: p.mint, symbol: p.symbol, side: 'sell', amountRaw: amount.toString(), sol: received,
        priceSol: fill.priceSol, priceUsd: fill.priceSol * this.solUsd * 10 ** p.decimals, feeSol: fill.feeSol, signature: fill.signature,
        reason, mode: this.d.executor.mode, ts: Date.now(), pnlSol: pnl,
        expectedPriceSol: expected?.expectedSolOut && amount > 0n ? expected.expectedSolOut / Number(amount) : undefined, slippagePct, exitKind,
      });
      this.d.risk.onExit(p.mint, pnl, closedFully);
      this.trackSlippage(p.mint, p.symbol, slippagePct);
      this.sellFailures.delete(p.id);
      this.emit('trade', { side: 'sell', symbol: p.symbol, mint: p.mint, sol: received, pnlSol: pnl, reason, closedFully });
      const pnlPct = costPart ? (pnl / costPart) * 100 : 0;
      log.info(`${closedFully ? 'CLOSED' : 'PARTIAL'} ${p.symbol}: +${received.toFixed(4)} SOL, pnl ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${fmtPct(pnlPct)}) sig=${fill.signature ?? '-'}`);
      await this.d.notifier.send(
        `${pnl >= 0 ? '✅' : '🔻'} <b>${closedFully ? 'SOLD' : 'PARTIAL SELL'} ${h(p.symbol)}</b> (${this.d.executor.mode})\n${h(reason)}\nReceived ${received.toFixed(4)} SOL | PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${fmtPct(pnlPct)})` +
          (fill.signature && this.d.executor.mode === 'live' ? `\nhttps://solscan.io/tx/${fill.signature}` : ''),
      );
    } catch (e) {
      const n = (this.sellFailures.get(p.id) ?? 0) + 1;
      this.sellFailures.set(p.id, n);
      log.error(`sell failed for ${p.symbol} (attempt ${n}): ${(e as Error).message}`);
      if (n === 3) await this.d.notifier.send(`⚠️ <b>Sell keeps failing for ${h(p.symbol)}</b>: ${h((e as Error).message)}\nCheck the token manually (possible honeypot / low liquidity).`);
    }
  }

  private closeRecord(p: Position, reason: string) {
    p.status = 'closed';
    p.closedAt = Date.now();
    p.closeReason = reason;
    this.open.delete(p.mint);
    this.d.store.upsertPosition(p);
  }

  /* -------------------------------------------------------------- entries */
  private async manageEntries() {
    const balance = await this.d.executor.solBalance();
    this.lastBalance = balance;
    this.d.risk.rollDay(balance);
    const exposure = [...this.open.values()].reduce((a, p) => a + p.costSol, 0);

    // rank candidates by signal so the best setup gets the slot
    const ranked: { c: Candidate; sig: Signal }[] = [];
    for (const c of this.tracked.values()) {
      if (this.open.has(c.mint)) continue;
      const n = this.candles.get(c.mint).length;
      if (n < this.cfg.loop.warmupCandles) {
        this.lastSignals.set(c.mint, { action: 'hold', score: 0, reasons: [`warming up (${n}/${this.cfg.loop.warmupCandles} candles)`], strategy: this.d.strategy.name });
        continue;
      }
      const sig = this.signalFor(c.mint);
      this.lastSignals.set(c.mint, sig);
      if (this.cfg.blacklist.includes(c.mint) || this.autoBlacklist.has(c.mint)) continue;
      if (sig.action === 'buy' && sig.score >= this.cfg.strategy.minBuyScore) ranked.push({ c, sig });
      else if (sig.score >= 0.4) log.debug(`${c.symbol}: ${sig.action} ${sig.score.toFixed(2)} - ${sig.reasons.slice(0, 3).join('; ')}`);
    }
    ranked.sort((a, b) => b.sig.score - a.sig.score);
    if (this.paused) {
      if (ranked.length) log.info(`paused: skipping ${ranked.length} buy signal(s) (${ranked.map((r) => r.c.symbol).join(', ')})`);
      return;
    }
    if (!this.regime.ok) {
      if (ranked.length) log.info(`risk-off (${this.regime.reason}): skipping ${ranked.map((r) => r.c.symbol).join(', ')}`);
      return;
    }

    let exp = exposure;
    let bal = balance;
    for (const { c, sig } of ranked) {
      const check = this.d.risk.canOpen({ openPositions: this.open.size, exposureSol: exp, balanceSol: bal, mint: c.mint });
      if (!check.ok) {
        log.info(`skip ${c.symbol} (score ${sig.score.toFixed(2)}): ${check.reason}`);
        if (check.reason?.startsWith('re-entry')) continue; // per-token limit: try the next candidate
        break; // global limit: nothing else can open this tick
      }
      const stopPct = this.d.risk.stopPctFor(atrPct(this.candles.get(c.mint), this.cfg.risk.volatility.atrPeriod));
      const size = this.d.risk.positionSize(bal, exp, stopPct);
      if (size <= 0) {
        log.info(`skip ${c.symbol}: risk-based size too small (stop ${stopPct.toFixed(1)}%)`);
        continue;
      }
      const spent = await this.enter(c, sig, size, stopPct);
      if (spent > 0) {
        exp += spent;
        bal -= spent;
      }
    }
  }

  private async enter(c: Candidate, sig: Signal, sizeSol: number, stopPct?: number, lane: 'core' | 'launch' = 'core'): Promise<number> {
    const stop = stopPct ?? this.d.risk.stopPctFor(atrPct(this.candles.get(c.mint), this.cfg.risk.volatility.atrPeriod));
    log.info(`BUY ${lane === 'launch' ? 'launch' : 'signal'} ${c.symbol} score=${sig.score.toFixed(2)} size=${sizeSol} SOL stop=${stop.toFixed(1)}% :: ${sig.reasons.slice(0, 4).join('; ')}`);
    try {
      const preview = await this.d.executor.previewBuy(c.mint, sizeSol);
      const q = lane === 'launch'
        ? this.d.risk.checkQuote(preview, { maxPriceImpactPct: this.cfg.launch.maxPriceImpactPct, maxRoundTripLossPct: this.cfg.launch.maxRoundTripLossPct })
        : this.d.risk.checkQuote(preview);
      if (!q.ok) {
        log.warn(`skip ${c.symbol}: ${q.reason}`);
        if (preview.roundTripLossPct !== undefined && preview.roundTripLossPct > this.cfg.risk.maxRoundTripLossPct) this.blacklistAuto(c.mint, c.symbol, q.reason ?? 'sell-path check failed');
        return 0;
      }
      const fill = await this.d.executor.buy(c.mint, c.decimals, sizeSol);
      const spent = fromRaw(fill.inputAmountRaw, 9) + fill.feeSol;
      const slippagePct = preview.expectedPriceSol ? ((fill.priceSol - preview.expectedPriceSol) / preview.expectedPriceSol) * 100 : undefined;
      const p: Position = {
        id: uid(),
        mint: c.mint,
        symbol: c.symbol,
        decimals: c.decimals,
        amountRaw: fill.outputAmountRaw.toString(),
        costSol: spent,
        entryPriceSol: fill.priceSol,
        entryPriceUsd: fill.priceSol * this.solUsd * 10 ** c.decimals,
        openedAt: Date.now(),
        highWaterMarkSol: fill.priceSol,
        ladderDone: 0,
        realisedSol: 0,
        strategy: sig.strategy,
        status: 'open',
        stopPct: stop,
        lane,
      };
      this.open.set(c.mint, p);
      this.d.store.upsertPosition(p);
      this.d.store.insertTrade({
        positionId: p.id, mint: c.mint, symbol: c.symbol, side: 'buy', amountRaw: p.amountRaw, sol: spent, priceSol: fill.priceSol,
        priceUsd: p.entryPriceUsd, feeSol: fill.feeSol, signature: fill.signature, reason: `${sig.strategy} ${sig.score.toFixed(2)}: ${sig.reasons.slice(0, 3).join('; ')}`,
        mode: this.d.executor.mode, ts: Date.now(), expectedPriceSol: preview.expectedPriceSol, slippagePct,
      });
      this.d.risk.onEntry();
      this.trackSlippage(c.mint, c.symbol, slippagePct);
      this.emit('trade', { side: 'buy', symbol: c.symbol, mint: c.mint, sol: spent, reason: sig.reasons.join('; '), lane });
      log.info(`OPENED ${lane === 'launch' ? '[launch] ' : ''}${c.symbol}: ${fromRaw(fill.outputAmountRaw, c.decimals).toFixed(4)} tokens for ${spent.toFixed(4)} SOL @ $${fmtNum(p.entryPriceUsd, 6)} sig=${fill.signature ?? '-'}`);
      await this.d.notifier.send(
        `🟢 <b>BOUGHT ${h(c.symbol)}</b> (${this.d.executor.mode})\n${spent.toFixed(4)} SOL @ $${fmtNum(p.entryPriceUsd, 6)}\nScore ${sig.score.toFixed(2)}: ${h(sig.reasons.slice(0, 3).join('; '))}` +
          (fill.signature && this.d.executor.mode === 'live' ? `\nhttps://solscan.io/tx/${fill.signature}` : ''),
      );
      return spent;
    } catch (e) {
      log.error(`buy failed for ${c.symbol}: ${(e as Error).message}`);
      return 0;
    }
  }

  /* ------------------------------------------------------------ slippage */
  private trackSlippage(mint: string, symbol: string, slippagePct?: number) {
    if (slippagePct === undefined) return;
    if (Math.abs(slippagePct) > 0.5) log.info(`${symbol}: execution ${slippagePct > 0 ? 'worse' : 'better'} than quote by ${Math.abs(slippagePct).toFixed(2)}%`);
    const ab = this.cfg.risk.autoBlacklist;
    if (!ab.enabled) return;
    const st = this.d.store.slippageStats().byMint[mint];
    if (st && st.fills >= ab.minFills && st.avgPct > ab.maxAvgSlippagePct) {
      this.blacklistAuto(mint, symbol, `average execution shortfall ${st.avgPct.toFixed(2)}% over ${st.fills} fills`);
    }
  }

  private blacklistAuto(mint: string, symbol: string, why: string) {
    if (this.autoBlacklist.has(mint)) return;
    this.autoBlacklist.add(mint);
    this.d.store.setJson('autoBlacklist', [...this.autoBlacklist]);
    log.warn(`auto-blacklisted ${symbol}: ${why}`);
    void this.d.notifier.send(`⛔ <b>${h(symbol)} blacklisted</b>: ${h(why)}`);
  }

  /* --------------------------------------------------------------- status */
  private async logStatus() {
    const balance = await this.d.executor.solBalance();
    const rs = this.d.risk.state;
    const lines = [...this.open.values()].map((p) => {
      const price = this.priceSolPerRaw(p.mint, p.decimals);
      const g = price ? this.d.positions.gainPct(p, price) : undefined;
      const age = Math.round((Date.now() - p.openedAt) / 60000);
      return `  ${(p.lane === 'launch' ? '🚀' + p.symbol : p.symbol).padEnd(8)} ${fmtPct(g).padStart(8)}  cost ${p.costSol.toFixed(3)} SOL  hwm ${fmtPct(p.entryPriceSol ? ((p.highWaterMarkSol - p.entryPriceSol) / p.entryPriceSol) * 100 : 0)}  tp ${p.ladderDone}/${this.cfg.risk.takeProfitLadder.length}  ${age}m`;
    });
    log.info(
      `status: balance ${balance.toFixed(4)} SOL | SOL $${this.solUsd.toFixed(2)} | daily pnl ${rs.dailyPnlSol >= 0 ? '+' : ''}${rs.dailyPnlSol.toFixed(4)} SOL | trades today ${rs.tradesToday} | tracking ${this.tracked.size} | open ${this.open.size}` +
        (rs.haltedReason ? ` | HALTED: ${rs.haltedReason}` : '') +
        (this.regime.ok ? '' : ` | RISK-OFF: ${this.regime.reason}`) +
        (lines.length ? '\n' + lines.join('\n') : ''),
    );
  }
}
