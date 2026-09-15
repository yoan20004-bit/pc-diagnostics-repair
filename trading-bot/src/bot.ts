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
import type { Executor } from './trading/executor.js';
import type { PositionManager } from './trading/positions.js';
import type { RiskManager } from './trading/risk.js';
import type { Candidate, PairInfo, Position, Signal } from './types.js';
import { SOL_MINT, fmtNum, fmtPct, fromRaw, shortMint, sleep, uid } from './utils.js';

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
  strategy: Strategy;
  notifier: Notifier;
  walletAddress: string;
}

export class TradingBot {
  readonly candles: CandleStore;
  private tracked = new Map<string, Candidate>();
  private pairs = new Map<string, PairInfo>();
  private open = new Map<string, Position>(); // one position per mint
  private sellFailures = new Map<string, number>();
  private seeded = new Set<string>();
  private solUsd = 0;
  private running = false;
  private tickNo = 0;
  private lastScan = 0;
  private lastPairRefresh = 0;

  constructor(private cfg: BotConfig, private env: EnvConfig, private d: BotDeps) {
    this.candles = new CandleStore(cfg.loop.candleTimeframeSec * 1000, cfg.loop.maxCandles);
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

  async start() {
    this.running = true;
    for (const p of this.d.store.openPositions()) this.open.set(p.mint, p);
    const balance = await this.d.executor.solBalance();
    this.d.risk.rollDay(balance);
    log.info(`mode=${this.d.executor.mode} wallet=${this.d.walletAddress} balance=${balance.toFixed(4)} SOL strategy=${this.d.strategy.name} open=${this.open.size}`);
    await this.d.notifier.send(`🤖 <b>Bot started</b> (${this.d.executor.mode})\nWallet: <code>${this.d.walletAddress}</code>\nBalance: ${balance.toFixed(4)} SOL\nOpen positions: ${this.open.size}`);

    // make sure positions restored from disk are tracked with pair + candles
    for (const p of this.open.values()) {
      try {
        const pairs = await this.d.dex.getTokenPairs(p.mint);
        const pair = bestPair(pairs, p.mint);
        if (pair) this.pairs.set(p.mint, pair);
        this.tracked.set(p.mint, { mint: p.mint, symbol: p.symbol, name: p.symbol, decimals: p.decimals, source: ['position'], pair, safetyScore: 0, safetyReasons: [], discoveredAt: Date.now() });
      } catch (e) {
        log.warn(`could not load pair for ${p.symbol}: ${(e as Error).message}`);
      }
    }

    while (this.running) {
      const started = Date.now();
      try {
        await this.tick();
      } catch (e) {
        log.error('tick failed:', (e as Error).message);
      }
      const elapsed = Date.now() - started;
      await sleep(Math.max(1000, this.cfg.loop.pollIntervalSec * 1000 - elapsed));
    }
  }

  stop() {
    this.running = false;
  }

  async tick() {
    this.tickNo++;
    const now = Date.now();
    if (now - this.lastScan >= this.cfg.loop.scanIntervalSec * 1000) await this.scan();

    const mints = [...new Set([...this.tracked.keys(), ...this.open.keys()])];
    if (!mints.length) {
      log.info('nothing to track yet (empty watchlist and scanner found no candidates)');
      return;
    }
    await this.refreshPrices(mints, now);
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
    if (this.tickNo % 4 === 1) await this.logStatus();
  }

  private async refreshPrices(mints: string[], now: number) {
    const prices = await this.d.jup.getPrices([SOL_MINT, ...mints]);
    if (prices[SOL_MINT]) this.solUsd = prices[SOL_MINT].usdPrice;
    for (const m of mints) {
      const p = prices[m];
      if (p) this.candles.addTick(m, p.usdPrice, now);
      else log.debug(`no price for ${shortMint(m)}`);
    }
  }

  async scan() {
    this.lastScan = Date.now();
    let candidates: Candidate[] = [];
    try {
      candidates = await this.d.scanner.discover(this.cfg.watchlist);
    } catch (e) {
      log.warn('scan failed:', (e as Error).message);
      return;
    }
    const next = new Map<string, Candidate>();
    for (const c of candidates) next.set(c.mint, c);
    for (const [m, c] of this.tracked) if (this.open.has(m) && !next.has(m)) next.set(m, c); // never drop a held token
    const added = [...next.keys()].filter((m) => !this.tracked.has(m));
    const dropped = [...this.tracked.keys()].filter((m) => !next.has(m));
    this.tracked = next;
    for (const c of candidates) if (c.pair) this.pairs.set(c.mint, c.pair);
    for (const m of dropped) {
      this.candles.remove(m);
      this.seeded.delete(m);
    }
    if (added.length || dropped.length) {
      log.info(`tracking ${this.tracked.size} tokens: ${[...this.tracked.values()].map((c) => c.symbol).join(', ')}` + (dropped.length ? ` (dropped ${dropped.length})` : ''));
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
    return this.d.strategy.evaluate({
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
      const decision = this.d.positions.checkExit(p, price, sig);
      this.d.store.upsertPosition(p); // persist high-water mark
      if (!decision) continue;
      const failures = this.sellFailures.get(p.id) ?? 0;
      if (failures > 0 && this.tickNo % Math.min(2 ** failures, 16) !== 0) continue; // back off after failures
      await this.exit(p, decision.sellPct, `${decision.kind}: ${decision.reason}`, decision.kind === 'takeProfit');
    }
  }

  private async exit(p: Position, sellPct: number, reason: string, isLadderRung: boolean) {
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
      const fill = await this.d.executor.sell(p.mint, p.decimals, amount);
      const received = fromRaw(fill.outputAmountRaw, 9);
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
      });
      this.d.risk.onExit(p.mint, pnl, closedFully);
      this.sellFailures.delete(p.id);
      const pnlPct = costPart ? (pnl / costPart) * 100 : 0;
      log.info(`${closedFully ? 'CLOSED' : 'PARTIAL'} ${p.symbol}: +${received.toFixed(4)} SOL, pnl ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${fmtPct(pnlPct)}) sig=${fill.signature ?? '-'}`);
      await this.d.notifier.send(
        `${pnl >= 0 ? '✅' : '🔻'} <b>${closedFully ? 'SOLD' : 'PARTIAL SELL'} ${p.symbol}</b> (${this.d.executor.mode})\n${reason}\nReceived ${received.toFixed(4)} SOL | PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${fmtPct(pnlPct)})` +
          (fill.signature && this.d.executor.mode === 'live' ? `\nhttps://solscan.io/tx/${fill.signature}` : ''),
      );
    } catch (e) {
      const n = (this.sellFailures.get(p.id) ?? 0) + 1;
      this.sellFailures.set(p.id, n);
      log.error(`sell failed for ${p.symbol} (attempt ${n}): ${(e as Error).message}`);
      if (n === 3) await this.d.notifier.send(`⚠️ <b>Sell keeps failing for ${p.symbol}</b>: ${(e as Error).message}\nCheck the token manually (possible honeypot / low liquidity).`);
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
    this.d.risk.rollDay(balance);
    const exposure = [...this.open.values()].reduce((a, p) => a + p.costSol, 0);

    // rank candidates by signal so the best setup gets the slot
    const ranked: { c: Candidate; sig: Signal }[] = [];
    for (const c of this.tracked.values()) {
      if (this.open.has(c.mint) || this.cfg.blacklist.includes(c.mint)) continue;
      if (this.candles.get(c.mint).length < this.cfg.loop.warmupCandles) continue;
      const sig = this.signalFor(c.mint);
      if (sig.action === 'buy' && sig.score >= this.cfg.strategy.minBuyScore) ranked.push({ c, sig });
      else if (sig.score >= 0.4) log.debug(`${c.symbol}: ${sig.action} ${sig.score.toFixed(2)} - ${sig.reasons.slice(0, 3).join('; ')}`);
    }
    ranked.sort((a, b) => b.sig.score - a.sig.score);

    let exp = exposure;
    let bal = balance;
    for (const { c, sig } of ranked) {
      const check = this.d.risk.canOpen({ openPositions: this.open.size, exposureSol: exp, balanceSol: bal, mint: c.mint });
      if (!check.ok) {
        log.info(`skip ${c.symbol} (score ${sig.score.toFixed(2)}): ${check.reason}`);
        if (check.reason?.startsWith('re-entry')) continue; // per-token limit: try the next candidate
        break; // global limit: nothing else can open this tick
      }
      const size = this.d.risk.positionSize(bal, exp);
      const spent = await this.enter(c, sig, size);
      if (spent > 0) {
        exp += spent;
        bal -= spent;
      }
    }
  }

  private async enter(c: Candidate, sig: Signal, sizeSol: number): Promise<number> {
    log.info(`BUY signal ${c.symbol} score=${sig.score.toFixed(2)} size=${sizeSol} SOL :: ${sig.reasons.slice(0, 4).join('; ')}`);
    try {
      const preview = await this.d.executor.previewBuy(c.mint, sizeSol);
      const q = this.d.risk.checkQuote(preview);
      if (!q.ok) {
        log.warn(`skip ${c.symbol}: ${q.reason}`);
        return 0;
      }
      const fill = await this.d.executor.buy(c.mint, c.decimals, sizeSol);
      const spent = fromRaw(fill.inputAmountRaw, 9) + fill.feeSol;
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
      };
      this.open.set(c.mint, p);
      this.d.store.upsertPosition(p);
      this.d.store.insertTrade({
        positionId: p.id, mint: c.mint, symbol: c.symbol, side: 'buy', amountRaw: p.amountRaw, sol: spent, priceSol: fill.priceSol,
        priceUsd: p.entryPriceUsd, feeSol: fill.feeSol, signature: fill.signature, reason: `${sig.strategy} ${sig.score.toFixed(2)}: ${sig.reasons.slice(0, 3).join('; ')}`,
        mode: this.d.executor.mode, ts: Date.now(),
      });
      this.d.risk.onEntry();
      log.info(`OPENED ${c.symbol}: ${fromRaw(fill.outputAmountRaw, c.decimals).toFixed(4)} tokens for ${spent.toFixed(4)} SOL @ $${fmtNum(p.entryPriceUsd, 6)} sig=${fill.signature ?? '-'}`);
      await this.d.notifier.send(
        `🟢 <b>BOUGHT ${c.symbol}</b> (${this.d.executor.mode})\n${spent.toFixed(4)} SOL @ $${fmtNum(p.entryPriceUsd, 6)}\nScore ${sig.score.toFixed(2)}: ${sig.reasons.slice(0, 3).join('; ')}` +
          (fill.signature && this.d.executor.mode === 'live' ? `\nhttps://solscan.io/tx/${fill.signature}` : ''),
      );
      return spent;
    } catch (e) {
      log.error(`buy failed for ${c.symbol}: ${(e as Error).message}`);
      return 0;
    }
  }

  /* --------------------------------------------------------------- status */
  private async logStatus() {
    const balance = await this.d.executor.solBalance();
    const rs = this.d.risk.state;
    const lines = [...this.open.values()].map((p) => {
      const price = this.priceSolPerRaw(p.mint, p.decimals);
      const g = price ? this.d.positions.gainPct(p, price) : undefined;
      const age = Math.round((Date.now() - p.openedAt) / 60000);
      return `  ${p.symbol.padEnd(8)} ${fmtPct(g).padStart(8)}  cost ${p.costSol.toFixed(3)} SOL  hwm ${fmtPct(p.entryPriceSol ? ((p.highWaterMarkSol - p.entryPriceSol) / p.entryPriceSol) * 100 : 0)}  tp ${p.ladderDone}/${this.cfg.risk.takeProfitLadder.length}  ${age}m`;
    });
    log.info(
      `status: balance ${balance.toFixed(4)} SOL | SOL $${this.solUsd.toFixed(2)} | daily pnl ${rs.dailyPnlSol >= 0 ? '+' : ''}${rs.dailyPnlSol.toFixed(4)} SOL | trades today ${rs.tradesToday} | tracking ${this.tracked.size} | open ${this.open.size}` +
        (rs.haltedReason ? ` | HALTED: ${rs.haltedReason}` : '') +
        (lines.length ? '\n' + lines.join('\n') : ''),
    );
  }
}
