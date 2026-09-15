#!/usr/bin/env node
// Silence Node's experimental-SQLite notice and a noisy dependency deprecation; everything else still surfaces.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  if (w.name === 'DeprecationWarning' && /punycode/.test(w.message)) return;
  console.warn(`${w.name}: ${w.message}`);
});
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PublicKey } from '@solana/web3.js';
import { TokenScanner } from './analysis/scanner.js';
import { parseCandlesCsv, runBacktest } from './backtest/engine.js';
import { TradingBot } from './bot.js';
import { loadConfig, loadEnv, type BotConfig, type EnvConfig } from './config.js';
import { createLogger, setLogLevel, type LogLevel } from './logger.js';
import { DexScreenerClient, bestPair } from './market/dexscreener.js';
import { GeckoTerminalClient } from './market/geckoterminal.js';
import { JupiterClient } from './market/jupiter.js';
import { Notifier } from './notify/telegram.js';
import { SolanaRpc } from './rpc.js';
import { Store } from './storage/db.js';
import { createStrategy } from './strategies/registry.js';
import { LiveExecutor, PaperExecutor, type Executor, type PaperState } from './trading/executor.js';
import { PositionManager } from './trading/positions.js';
import { PanelServer } from './server/panel.js';
import { PriceStream } from './market/stream.js';
import { RiskManager, type RiskState } from './trading/risk.js';
import { fmtNum, fmtPct, fromRaw, SOL_MINT } from './utils.js';
import { decryptSecret, encryptSecret, generateWallet, keypairToBase58, loadKeypair, type EncryptedKey } from './wallet.js';
import { tune } from './backtest/tuner.js';
import { TelegramCommandLoop } from './notify/commands.js';
import { fmtPct as fmtP, escapeHtml as h } from './utils.js';

const log = createLogger('cli');

const HELP = `
Phantom Solana Trading Bot

Usage:
  phantom-bot run [--mode paper|live] [--config config.yaml]   Start the bot + control panel (http://localhost:8787)
                  [--no-panel] [--port 8787]
  phantom-bot scan                                            Discover + safety-check tradeable tokens
  phantom-bot check <mint>                                    Deep safety report for one token
  phantom-bot balance                                         Wallet SOL + token balances
  phantom-bot positions                                       Open positions, recent trades, PnL
  phantom-bot buy <mint> <sol>                                Manual buy (respects --mode)
  phantom-bot sell <mint> [--pct 100]                         Manual sell
  phantom-bot wallet new [--save path.json]                   Generate a dedicated bot wallet
  phantom-bot wallet encrypt                                  Store PRIVATE_KEY encrypted in data/wallet.enc (password protected)
  phantom-bot backtest (--mint <mint> | --file candles.csv) [--strategy composite] [--timeframe 60] [--limit 1000]
  phantom-bot tune --mint <a> [--mint <b> ...] [--strategy x] [--apply]   Walk-forward parameter search (out-of-sample ranked)

Options:
  --mode      paper (default, simulated) or live (real transactions; needs I_UNDERSTAND_THE_RISKS=yes)
  --config    path to config.yaml
  --log       debug | info | warn | error
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      config: { type: 'string' },
      'no-panel': { type: 'boolean' },
      port: { type: 'string' },
      log: { type: 'string' },
      save: { type: 'string' },
      pct: { type: 'string' },
      mint: { type: 'string', multiple: true },
      apply: { type: 'boolean' },
      combos: { type: 'string' },
      file: { type: 'string' },
      strategy: { type: 'string' },
      timeframe: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (!cmd || values.help) {
    console.log(HELP);
    return;
  }
  const env = loadEnv();
  if (values.mode) env.mode = values.mode === 'live' ? 'live' : 'paper';
  setLogLevel(((values.log as LogLevel) || env.logLevel) as LogLevel);
  if (values.config) env.configPath = resolve(process.cwd(), values.config);
  if (values['no-panel']) env.panel.enabled = false;
  if (values.port) env.panel.port = Number(values.port);
  const cfg = loadConfig(values.config);

  switch (cmd) {
    case 'run':
      return runBot(cfg, env);
    case 'scan':
      return scan(cfg, env);
    case 'check':
      return check(cfg, env, positionals[1]);
    case 'balance':
      return balance(cfg, env);
    case 'positions':
      return positions(env);
    case 'buy':
      return manualBuy(cfg, env, positionals[1], Number(positionals[2]));
    case 'sell':
      return manualSell(cfg, env, positionals[1], Number(values.pct ?? 100));
    case 'wallet':
      return wallet(positionals[1], values.save);
    case 'backtest':
      return backtest(cfg, env, values as Record<string, string | boolean | string[] | undefined>);
    case 'tune':
      return tuneCmd(cfg, env, values as Record<string, string | boolean | string[] | undefined>);
    default:
      console.log(HELP);
      throw new Error(`Unknown command: ${cmd}`);
  }
}

/* ---------------------------------------------------------------- wiring */

interface Ctx {
  cfg: BotConfig;
  env: EnvConfig;
  rpc: SolanaRpc;
  jup: JupiterClient;
  dex: DexScreenerClient;
  gecko: GeckoTerminalClient;
  scanner: TokenScanner;
  store: Store;
}

function buildCtx(cfg: BotConfig, env: EnvConfig): Ctx {
  const rpc = new SolanaRpc(env.rpcUrl, env.rpcWsUrl);
  const jup = new JupiterClient(env.jupiterApiKey);
  const dex = new DexScreenerClient();
  const gecko = new GeckoTerminalClient();
  const scanner = new TokenScanner(cfg, jup, dex, rpc);
  const store = new Store(env.dbPath);
  return { cfg, env, rpc, jup, dex, gecko, scanner, store };
}

const ENC_PATH = () => resolve(process.cwd(), 'data/wallet.enc');

async function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = process.stdout;
  return new Promise((res) => {
    const origWrite = out.write.bind(out);
    let muted = false;
    (out as unknown as { write: typeof origWrite }).write = ((chunk: string | Uint8Array, ...rest: unknown[]) => (muted ? true : (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof origWrite;
    rl.question(question, (answer) => {
      (out as unknown as { write: typeof origWrite }).write = origWrite;
      rl.close();
      process.stdout.write('\n');
      res(answer);
    });
    muted = true;
  });
}

async function walletFromEnv(env: EnvConfig, required: boolean) {
  if (env.privateKey) return loadKeypair(env.privateKey);
  if (existsSync(ENC_PATH())) {
    const enc = JSON.parse(readFileSync(ENC_PATH(), 'utf8')) as EncryptedKey;
    const pw = process.env.WALLET_PASSWORD || (process.stdin.isTTY ? await askHidden('Wallet password: ') : '');
    if (!pw) throw new Error('data/wallet.enc found but no password given (set WALLET_PASSWORD or run interactively)');
    return loadKeypair(decryptSecret(enc, pw));
  }
  if (required) throw new Error('PRIVATE_KEY is not set. Export it from Phantom (Settings -> Manage Accounts -> Show Private Key), run `npm run wallet:new`, or `npm run wallet:encrypt`.');
  return undefined;
}

function assertLiveAllowed(env: EnvConfig) {
  if (env.mode === 'live' && !env.riskAcknowledged) {
    throw new Error('Live mode requires I_UNDERSTAND_THE_RISKS=yes in .env. Trading bots can and do lose money; start with paper mode.');
  }
}

async function buildExecutor(ctx: Ctx, priceSolPerRaw: (mint: string) => number | undefined): Promise<{ executor: Executor; address: string }> {
  const { env, cfg, rpc, jup, store } = ctx;
  const kp = await walletFromEnv(env, env.mode === 'live');
  if (env.mode === 'live') {
    assertLiveAllowed(env);
    return { executor: new LiveExecutor(rpc, jup, kp!, cfg.execution), address: kp!.publicKey.toBase58() };
  }
  const saved = store.getJson<PaperState>('paper');
  const executor = new PaperExecutor(priceSolPerRaw, cfg.execution, saved, (s) => store.setJson('paper', s));
  return { executor, address: kp ? kp.publicKey.toBase58() : 'paper-wallet' };
}

/* ---------------------------------------------------------------- commands */

async function runBot(cfg: BotConfig, env: EnvConfig) {
  const ctx = buildCtx(cfg, env);
  const risk = new RiskManager(cfg.risk, ctx.store.getJson<RiskState>('risk'), (s) => ctx.store.setJson('risk', s));
  let bot: TradingBot;
  const { executor, address } = await buildExecutor(ctx, (mint) => {
    const d = bot.decimalsOf(mint);
    return d === undefined ? undefined : bot.priceSolPerRaw(mint, d);
  });
  const strategy = createStrategy(cfg.strategy.name);
  const notifier = new Notifier(env.telegramToken, env.telegramChatId);
  const stream = cfg.stream.enabled ? new PriceStream(ctx.rpc.connection, cfg.stream.maxSubscriptions) : undefined;
  bot = new TradingBot(cfg, env, {
    jup: ctx.jup, dex: ctx.dex, gecko: ctx.gecko, scanner: ctx.scanner, store: ctx.store, executor, risk,
    positions: new PositionManager(cfg.risk, cfg.strategy.minSellScore, cfg.launch.exits), strategy, notifier, walletAddress: address, stream,
  });
  if (cfg.launch.enabled) log.warn(`LAUNCH LANE ENABLED: sniping brand-new tokens with ${cfg.launch.sizeSol} SOL each, max ${cfg.launch.maxOpen} open / ${cfg.launch.maxPerHour} per hour. This is the highest-risk mode.`);

  if (env.mode === 'live') {
    log.warn('LIVE MODE: real transactions will be sent from ' + address);
  } else {
    log.info('PAPER MODE: fills are simulated; no transactions are sent. Paper balance: ' + (await executor.solBalance()).toFixed(3) + ' SOL');
  }
  let panel: PanelServer | undefined;
  if (env.panel.enabled) {
    panel = new PanelServer({ host: env.panel.host, port: env.panel.port, token: env.panel.token, configPath: env.configPath }, { bot, store: ctx.store, scanner: ctx.scanner, dex: ctx.dex, gecko: ctx.gecko });
    try {
      await panel.listen();
    } catch (e) {
      log.warn(`control panel could not start (${(e as Error).message}); continuing without it. Use PANEL_PORT to pick another port.`);
      panel = undefined;
    }
    if (env.panel.host !== '127.0.0.1' && env.panel.host !== 'localhost' && !env.panel.token) {
      log.warn('PANEL_HOST exposes the panel to the network without PANEL_TOKEN - anyone who can reach it can trade with your wallet');
    }
  }
  let commands: TelegramCommandLoop | undefined;
  if (cfg.telegram.commands && env.telegramToken && env.telegramChatId) {
    commands = new TelegramCommandLoop(env.telegramToken, env.telegramChatId, {
      status: () => {
        const s = bot.snapshot();
        return `${s.running ? (s.paused ? '⏸ running, entries paused' : '▶ running') : '⏹ stopped'} (${s.mode})\nBalance ${s.balanceSol.toFixed(4)} SOL | SOL $${s.solUsd.toFixed(2)}\nToday ${s.risk.dailyPnlSol >= 0 ? '+' : ''}${s.risk.dailyPnlSol.toFixed(4)} SOL, ${s.risk.tradesToday} trades | all-time ${s.stats.pnlSol >= 0 ? '+' : ''}${s.stats.pnlSol.toFixed(4)} SOL\nOpen ${s.positions.length}/${s.config.risk.maxOpenPositions}, tracking ${s.tracked.length}\nRegime: ${s.regime.ok ? 'OK' : 'RISK-OFF'} - ${h(s.regime.reason)}` + (s.risk.haltedReason ? `\nHALTED: ${h(s.risk.haltedReason)}` : '');
      },
      positions: () => {
        const ps = bot.snapshot().positions;
        return ps.length ? ps.map((p) => `${h(p.symbol)}: ${fmtP(p.gainPct)} | cost ${p.costSol.toFixed(3)} SOL | stop ${fmtP(p.stopLevelPct)} | TP ${p.ladderDone}/${p.ladderTotal} | ${p.ageMin}m`).join('\n') : 'no open positions';
      },
      pause: () => (bot.pause(), 'entries paused'),
      resume: () => (bot.resume(), 'entries resumed'),
      scan: () => (void bot.scanNow(), 'scan started'),
      close: async (target, pct) => {
        const p = bot.snapshot().positions.find((x) => x.symbol.toLowerCase() === target.toLowerCase() || x.mint === target);
        if (!p) return `no open position matching ${h(target)}`;
        await bot.closePosition(p.mint, pct);
        return `sold ${pct}% of ${h(p.symbol)}`;
      },
      stop: () => (bot.stop(), 'stopping trading loop'),
      start: () => (void bot.start(), 'starting trading loop'),
    });
    commands.start();
  }
  const shutdown = async () => {
    log.info('shutting down...');
    bot.stop();
    commands?.stop();
    panel?.close();
    await notifier.send('🛑 Bot stopped');
    ctx.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await bot.start();
  // loop stopped from the panel or Telegram: keep the process alive so it can be started again
  if (panel || commands) await new Promise(() => undefined);
}

async function scan(cfg: BotConfig, env: EnvConfig) {
  const ctx = buildCtx(cfg, env);
  const list = await ctx.scanner.discover(cfg.watchlist);
  if (!list.length) {
    console.log('No candidates passed the filters. Loosen scanner.filters in config.yaml or add a watchlist.');
    return;
  }
  console.log(`\n${'SYMBOL'.padEnd(10)} ${'SAFETY'.padStart(6)} ${'PRICE'.padStart(12)} ${'LIQ'.padStart(9)} ${'MCAP'.padStart(9)} ${'VOL24'.padStart(9)} ${'1H'.padStart(8)} ${'HOLDERS'.padStart(8)} ${'ORG'.padStart(4)}  MINT`);
  for (const c of list) {
    const t = c.token;
    console.log(
      `${c.symbol.slice(0, 10).padEnd(10)} ${String(c.safetyScore).padStart(6)} ${('$' + fmtNum(t?.usdPrice ?? c.pair?.priceUsd, 6)).padStart(12)} ${fmtNum(c.pair?.liquidityUsd ?? t?.liquidityUsd, 0).padStart(9)} ${fmtNum(t?.mcapUsd ?? c.pair?.marketCap, 0).padStart(9)} ${fmtNum(c.pair?.volume.h24, 0).padStart(9)} ${fmtPct(c.pair?.priceChange.h1 ?? t?.stats?.['1h']?.priceChange).padStart(8)} ${String(t?.holderCount ?? '-').padStart(8)} ${String(Math.round(t?.organicScore ?? 0)).padStart(4)}  ${c.mint}`,
    );
    if (c.safetyReasons.length) console.log(`  ${'notes:'.padEnd(10)} ${c.safetyReasons.join('; ')}`);
  }
  console.log(`\n${list.length} candidates. Sources: ${[...new Set(list.flatMap((c) => c.source))].join(', ')}`);
  ctx.store.close();
}

async function check(cfg: BotConfig, env: EnvConfig, mint?: string) {
  if (!mint) throw new Error('usage: check <mint>');
  new PublicKey(mint);
  const ctx = buildCtx(cfg, env);
  const r = await ctx.scanner.inspect(mint);
  const t = r.meta;
  console.log(`\nToken: ${t?.name ?? '?'} (${t?.symbol ?? '?'})  mint ${mint}`);
  console.log(`Price $${fmtNum(t?.usdPrice ?? r.pair?.priceUsd, 6)} | liquidity $${fmtNum(r.pair?.liquidityUsd ?? t?.liquidityUsd, 0)} | mcap $${fmtNum(t?.mcapUsd ?? r.pair?.marketCap, 0)} | holders ${t?.holderCount ?? '-'} | organic ${t?.organicScore?.toFixed(0) ?? '-'} (${t?.organicScoreLabel ?? '-'}) | verified ${t?.isVerified ?? '-'}`);
  if (r.pair) console.log(`Best pool: ${r.pair.dexId} ${r.pair.pairAddress} | vol24 $${fmtNum(r.pair.volume.h24, 0)} | 1h ${fmtPct(r.pair.priceChange.h1)} | 24h ${fmtPct(r.pair.priceChange.h24)} | buys/sells 1h ${r.pair.txns.h1.buys}/${r.pair.txns.h1.sells}`);
  console.log(`Audit: mintAuthDisabled=${t?.audit?.mintAuthorityDisabled ?? '?'} freezeAuthDisabled=${t?.audit?.freezeAuthorityDisabled ?? '?'} top10=${t?.audit?.topHoldersPercentage?.toFixed(1) ?? '?'}% dev=${t?.audit?.devBalancePercentage?.toFixed(1) ?? '?'}%`);
  console.log(`\nSAFETY: ${r.safety.ok ? 'PASS' : 'FAIL'} (score ${r.safety.score}/100)`);
  for (const h of r.safety.hardFail) console.log(`  ✖ ${h}`);
  for (const w of r.safety.reasons) console.log(`  • ${w}`);
  ctx.store.close();
}

async function balance(cfg: BotConfig, env: EnvConfig) {
  const ctx = buildCtx(cfg, env);
  const kp = (await walletFromEnv(env, true))!;
  const sol = await ctx.rpc.getSolBalance(kp.publicKey);
  console.log(`\nWallet ${kp.publicKey.toBase58()}\nSOL: ${sol.toFixed(6)}`);
  try {
    const bal = await ctx.jup.ultraBalances(kp.publicKey.toBase58());
    const mints = Object.keys(bal).filter((m) => m !== 'SOL' && bal[m].uiAmount > 0);
    if (mints.length) {
      const prices = await ctx.jup.getPrices(mints).catch(() => ({}) as Record<string, { usdPrice: number }>);
      const metas = await ctx.jup.getTokens(mints).catch(() => []);
      for (const m of mints) {
        const meta = metas.find((x) => x.id === m);
        const usd = prices[m]?.usdPrice;
        console.log(`${(meta?.symbol ?? m.slice(0, 8)).padEnd(10)} ${bal[m].uiAmount.toFixed(4).padStart(16)}  ${usd ? '$' + (usd * bal[m].uiAmount).toFixed(2) : ''}  ${m}`);
      }
    }
  } catch (e) {
    log.warn('token balance lookup failed:', (e as Error).message);
  }
  const paper = ctx.store.getJson<PaperState>('paper');
  if (paper) console.log(`\nPaper wallet: ${paper.solBalance.toFixed(4)} SOL, ${Object.keys(paper.tokens).length} token(s)`);
  ctx.store.close();
}

async function positions(env: EnvConfig) {
  const store = new Store(env.dbPath);
  const open = store.openPositions();
  console.log(`\nOpen positions (${open.length}):`);
  for (const p of open) {
    const age = Math.round((Date.now() - p.openedAt) / 60000);
    console.log(`  ${p.symbol.padEnd(8)} cost ${p.costSol.toFixed(4)} SOL  entry $${fmtNum(p.entryPriceUsd, 6)}  tokens ${fromRaw(p.amountRaw, p.decimals).toFixed(4)}  tp ${p.ladderDone}  ${age}m  ${p.mint}`);
  }
  const closed = store.recentClosedPositions(10);
  console.log(`\nRecently closed (${closed.length}):`);
  for (const p of closed) {
    const { pnlSol, costSol } = store.positionPnl(p.id);
    const pnlPct = costSol ? (pnlSol / costSol) * 100 : 0;
    console.log(`  ${p.symbol.padEnd(8)} cost ${costSol.toFixed(4)} -> ${p.realisedSol.toFixed(4)} SOL  pnl ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} (${fmtPct(pnlPct)})  ${p.closeReason ?? ''}`);
  }
  const s = store.stats();
  console.log(`\nAll time: ${s.trades} trades, ${s.sells} exits, ${s.wins} winners (${s.sells ? ((s.wins / s.sells) * 100).toFixed(0) : 0}%), pnl ${s.pnlSol >= 0 ? '+' : ''}${s.pnlSol.toFixed(4)} SOL, fees ${s.feesSol.toFixed(4)} SOL`);
  const recent = store.trades(10);
  if (recent.length) {
    console.log('\nLast trades:');
    for (const t of recent) console.log(`  ${new Date(t.ts).toISOString()} ${t.side.toUpperCase().padEnd(4)} ${t.symbol.padEnd(8)} ${t.sol.toFixed(4)} SOL ${t.pnlSol !== undefined ? `pnl ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)}` : ''} ${t.mode} ${t.reason.slice(0, 60)}`);
  }
  store.close();
}

async function manualBuy(cfg: BotConfig, env: EnvConfig, mint?: string, sol?: number) {
  if (!mint || !sol || !(sol > 0)) throw new Error('usage: buy <mint> <sol>');
  const ctx = buildCtx(cfg, env);
  const r = await ctx.scanner.inspect(mint);
  const decimals = r.meta?.decimals ?? (await ctx.rpc.getMintInfo(mint)).decimals;
  const solUsd = (await ctx.jup.getPrices([SOL_MINT]))[SOL_MINT]?.usdPrice ?? 0;
  const usd = r.meta?.usdPrice ?? r.pair?.priceUsd ?? 0;
  const { executor } = await buildExecutor(ctx, () => (usd && solUsd ? usd / solUsd / 10 ** decimals : undefined));
  if (!r.safety.ok) log.warn(`safety check FAILED: ${[...r.safety.hardFail, ...r.safety.reasons].join('; ')} - proceeding because this is a manual order`);
  const fill = await executor.buy(mint, decimals, sol);
  const spent = fromRaw(fill.inputAmountRaw, 9) + fill.feeSol;
  const symbol = r.meta?.symbol ?? mint.slice(0, 6);
  const p = {
    id: `${Date.now().toString(36)}-manual`, mint, symbol, decimals, amountRaw: fill.outputAmountRaw.toString(), costSol: spent,
    entryPriceSol: fill.priceSol, entryPriceUsd: fill.priceSol * solUsd * 10 ** decimals, openedAt: Date.now(), highWaterMarkSol: fill.priceSol,
    ladderDone: 0, realisedSol: 0, strategy: 'manual', status: 'open' as const,
  };
  ctx.store.upsertPosition(p);
  ctx.store.insertTrade({ positionId: p.id, mint, symbol, side: 'buy', amountRaw: p.amountRaw, sol: spent, priceSol: fill.priceSol, priceUsd: p.entryPriceUsd, feeSol: fill.feeSol, signature: fill.signature, reason: 'manual', mode: executor.mode, ts: Date.now() });
  console.log(`Bought ${fromRaw(fill.outputAmountRaw, decimals).toFixed(4)} ${symbol} for ${spent.toFixed(4)} SOL (${executor.mode}) ${fill.signature ?? ''}`);
  console.log('The running bot will manage this position with its exit rules.');
  ctx.store.close();
}

async function manualSell(cfg: BotConfig, env: EnvConfig, mint?: string, pctToSell = 100) {
  if (!mint) throw new Error('usage: sell <mint> [--pct 100]');
  const ctx = buildCtx(cfg, env);
  const pos = ctx.store.openPositions().find((p) => p.mint === mint);
  const decimals = pos?.decimals ?? (await ctx.rpc.getMintInfo(mint)).decimals;
  const solUsd = (await ctx.jup.getPrices([SOL_MINT]))[SOL_MINT]?.usdPrice ?? 0;
  const usd = (await ctx.jup.getPrices([mint]))[mint]?.usdPrice ?? 0;
  const { executor } = await buildExecutor(ctx, () => (usd && solUsd ? usd / solUsd / 10 ** decimals : undefined));
  const held = await executor.tokenBalance(mint);
  const amount = pctToSell >= 100 ? held : (held * BigInt(Math.round(pctToSell * 100))) / 10000n;
  if (amount <= 0n) throw new Error('nothing to sell');
  const fill = await executor.sell(mint, decimals, amount);
  const received = fromRaw(fill.outputAmountRaw, 9);
  console.log(`Sold ${fromRaw(amount, decimals).toFixed(4)} tokens for ${received.toFixed(4)} SOL (${executor.mode}) ${fill.signature ?? ''}`);
  if (pos) {
    const fraction = Number(amount) / Number(held || amount);
    const costPart = pos.costSol * fraction;
    pos.amountRaw = (held - amount).toString();
    pos.costSol -= costPart;
    pos.realisedSol += received;
    if (pctToSell >= 100 || held - amount <= 0n) {
      pos.status = 'closed';
      pos.closedAt = Date.now();
      pos.closeReason = 'manual sell';
    }
    ctx.store.upsertPosition(pos);
    ctx.store.insertTrade({ positionId: pos.id, mint, symbol: pos.symbol, side: 'sell', amountRaw: amount.toString(), sol: received, priceSol: fill.priceSol, priceUsd: fill.priceSol * solUsd * 10 ** decimals, feeSol: fill.feeSol, signature: fill.signature, reason: 'manual', mode: executor.mode, ts: Date.now(), pnlSol: received - costPart });
  }
  ctx.store.close();
}

async function wallet(sub?: string, save?: string) {
  if (sub === 'encrypt') {
    const env = loadEnv();
    let secret = env.privateKey;
    if (!secret) {
      if (!process.stdin.isTTY) throw new Error('set PRIVATE_KEY in .env (or the environment) before running wallet encrypt');
      secret = await askHidden('Private key (base58, from Phantom): ');
    }
    const kp = loadKeypair(secret);
    const pw = await askHidden('Choose a password (8+ chars): ');
    const pw2 = await askHidden('Repeat password: ');
    if (pw !== pw2) throw new Error('passwords do not match');
    writeFileSync(ENC_PATH(), JSON.stringify(encryptSecret(keypairToBase58(kp), pw), null, 2), { mode: 0o600 });
    console.log(`\nEncrypted key for ${kp.publicKey.toBase58()} written to data/wallet.enc.`);
    console.log('Now remove PRIVATE_KEY from .env. The bot will ask for the password at start (or read WALLET_PASSWORD).');
    return;
  }
  if (sub !== 'new') throw new Error('usage: wallet new [--save path.json] | wallet encrypt');
  const w = generateWallet();
  console.log('\nNew bot wallet generated.\n');
  console.log(`Public address : ${w.keypair.publicKey.toBase58()}`);
  console.log(`Private key    : ${w.base58}`);
  console.log('\n1. Put the private key in .env as PRIVATE_KEY=... (never share it, never commit it).');
  console.log('2. In Phantom: Add / Connect Wallet -> Import Private Key -> paste it to watch the bot wallet.');
  console.log('3. Send a small amount of SOL to the public address to fund trading + fees.');
  if (save) {
    writeFileSync(save, w.jsonArray, { mode: 0o600 });
    console.log(`\nKeypair JSON saved to ${save} (also usable as PRIVATE_KEY=${save}).`);
  }
}

async function backtest(cfg: BotConfig, env: EnvConfig, v: Record<string, string | boolean | string[] | undefined>) {
  const strategyName = (v.strategy as BotConfig['strategy']['name']) || cfg.strategy.name;
  const strategy = createStrategy(strategyName);
  const tf = Number(v.timeframe || cfg.loop.candleTimeframeSec);
  let candles;
  let label = '';
  if (v.file) {
    candles = parseCandlesCsv(readFileSync(String(v.file), 'utf8'));
    label = String(v.file);
  } else if (v.mint) {
    const ctx = buildCtx(cfg, env);
    const mint = Array.isArray(v.mint) ? v.mint[0] : String(v.mint);
    const r = await loadCandlesForMint(ctx, mint, tf, Number(v.limit || 1000));
    candles = r.candles;
    label = `${r.pair.baseToken.symbol} (${r.pair.dexId} ${r.pair.pairAddress})`;
    ctx.store.close();
  } else throw new Error('backtest needs --mint <mint> or --file candles.csv');
  if (candles.length < cfg.loop.warmupCandles + 10) throw new Error(`only ${candles.length} candles; need more history`);

  const r = runBacktest(candles, cfg, strategy);
  const span = ((candles[candles.length - 1].t - candles[0].t) / 3_600_000).toFixed(1);
  console.log(`\nBacktest ${label} | strategy ${strategyName} | ${r.candles} candles x ${tf}s (~${span}h)`);
  console.log(`Return        ${fmtPct(r.returnPct)}   (buy & hold ${fmtPct(r.buyAndHoldPct)})`);
  console.log(`Trades        ${r.trades.length}  wins ${r.wins}  losses ${r.losses}  win rate ${r.winRatePct.toFixed(1)}%`);
  console.log(`Avg win       ${fmtPct(r.avgWinPct)}   avg loss ${fmtPct(r.avgLossPct)}   profit factor ${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'}`);
  console.log(`Max drawdown  ${r.maxDrawdownPct.toFixed(2)}%   time in market ${((r.exposureBars / Math.max(1, r.candles)) * 100).toFixed(0)}%`);
  if (r.trades.length) {
    console.log('\nLast trades:');
    for (const t of r.trades.slice(-12)) console.log(`  ${new Date(t.entryTs).toISOString().slice(0, 16)} -> ${new Date(t.exitTs).toISOString().slice(0, 16)}  ${fmtPct(t.pnlPct).padStart(8)}  ${t.bars} bars  ${t.reason.slice(0, 70)}`);
  }
  console.log('\nNote: backtests ignore liquidity, latency and MEV. Treat results as an upper bound.');
}

async function loadCandlesForMint(ctx: Ctx, mint: string, tf: number, limit: number) {
  const pairs = await ctx.dex.getTokenPairs(mint);
  const pair = bestPair(pairs, mint);
  if (!pair) throw new Error(`no DexScreener pool found for ${mint}`);
  const candles = await ctx.gecko.getOhlcv(pair.pairAddress, tf, limit);
  return { pair, candles };
}

async function tuneCmd(cfg: BotConfig, env: EnvConfig, v: Record<string, string | boolean | string[] | undefined>) {
  const mints = Array.isArray(v.mint) ? v.mint : v.mint ? [String(v.mint)] : [];
  const files = v.file ? [String(v.file)] : [];
  if (!mints.length && !files.length) throw new Error('tune needs --mint <mint> (repeatable) or --file candles.csv');
  const tf = Number(v.timeframe || cfg.loop.candleTimeframeSec);
  const sets = [];
  const labels: string[] = [];
  for (const f of files) {
    sets.push(parseCandlesCsv(readFileSync(f, 'utf8')));
    labels.push(f);
  }
  if (mints.length) {
    const ctx = buildCtx(cfg, env);
    for (const m of mints) {
      const { pair, candles } = await loadCandlesForMint(ctx, m, tf, Number(v.limit || 1000));
      sets.push(candles);
      labels.push(`${pair.baseToken.symbol} (${candles.length} candles)`);
    }
    ctx.store.close();
  }
  console.log(`\nTuning ${v.strategy || cfg.strategy.name} on ${labels.join(', ')} ...`);
  let lastPct = -1;
  const r = await tune(sets, cfg, {
    strategy: (v.strategy as BotConfig['strategy']['name']) || undefined,
    maxCombos: v.combos ? Number(v.combos) : undefined,
    onProgress: (d, t) => {
      const pct = Math.floor((d / t) * 10) * 10;
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\r  ${pct}% (${d}/${t})`);
      }
    },
  });
  console.log(`\n\n${r.combosTried} combinations in ${(r.elapsedMs / 1000).toFixed(0)}s, ranked by out-of-sample (last ${Math.round((1 - r.trainFraction) * 100)}%) return minus half the drawdown.`);
  const row = (c: typeof r.baseline, name: string) => console.log(`  ${name.padEnd(9)} train ${fmtP(c.train.returnPct).padStart(8)} (${c.train.trades} trades)   test ${fmtP(c.test.returnPct).padStart(8)} (${c.test.trades} trades, dd ${c.test.maxDrawdownPct.toFixed(1)}%)   score ${Number.isFinite(c.score) ? c.score.toFixed(2) : 'n/a'}`);
  row(r.baseline, 'current');
  r.top.slice(0, 5).forEach((c, i) => row(c, `#${i + 1}`));
  if (!r.best) {
    console.log('\nNo parameter set beat the current configuration out of sample. Keeping current settings.');
    return;
  }
  console.log(`\nBest: ${JSON.stringify(r.best.params)}`);
  if (v.apply) {
    const yaml = await import('yaml');
    const path = env.configPath;
    const current = existsSync(path) ? (yaml.parse(readFileSync(path, 'utf8')) ?? {}) : {};
    const merged = deepMergeObj(current as Record<string, unknown>, r.patch ?? {});
    writeFileSync(path, yaml.stringify(merged));
    console.log(`Applied to ${path}. Restart the bot (or save in the panel) to use it.`);
  } else console.log('Run again with --apply to write these into config.yaml, or paste them under Settings in the panel.');
}

function deepMergeObj(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? deepMergeObj(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

main().catch((e) => {
  log.error((e as Error).message);
  process.exit(1);
});
