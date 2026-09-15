import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { PublicKey } from '@solana/web3.js';
import type { TokenScanner } from '../analysis/scanner.js';
import { runBacktest } from '../backtest/engine.js';
import type { TradingBot } from '../bot.js';
import { ConfigSchema, type BotConfig } from '../config.js';
import { createLogger, onLog, recentLogs } from '../logger.js';
import { bestPair, type DexScreenerClient } from '../market/dexscreener.js';
import type { GeckoTerminalClient } from '../market/geckoterminal.js';
import type { Store } from '../storage/db.js';
import { createStrategy } from '../strategies/registry.js';

const log = createLogger('panel');

export interface PanelOptions {
  host: string;
  port: number;
  token?: string;
  configPath: string;
}

export interface PanelDeps {
  bot: TradingBot;
  store: Store;
  scanner: TokenScanner;
  dex: DexScreenerClient;
  gecko: GeckoTerminalClient;
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

/**
 * Local control panel: static UI + JSON API + Server-Sent Events.
 * Binds to localhost by default; set PANEL_HOST=0.0.0.0 and PANEL_TOKEN to expose it.
 */
export class PanelServer {
  private server: Server;
  private clients = new Set<ServerResponse>();
  private html: string;
  private startedAt = Date.now();
  private stateTimer: NodeJS.Timeout | undefined;

  constructor(private opts: PanelOptions, private d: PanelDeps) {
    const here = dirname(fileURLToPath(import.meta.url));
    const htmlPath = [join(here, 'panel.html'), join(here, '..', '..', 'src', 'server', 'panel.html')].find((p) => existsSync(p));
    this.html = htmlPath ? readFileSync(htmlPath, 'utf8') : '<p>panel.html missing - run npm run build</p>';
    this.server = createServer((req, res) => void this.handle(req, res));
    onLog((e) => this.broadcast('log', e));
    const push = () => this.broadcast('state', this.d.bot.snapshot());
    this.d.bot.on('state', push);
    this.d.bot.on('trade', (t) => this.broadcast('trade', t));
    this.stateTimer = setInterval(push, 5000);
  }

  listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        const addr = this.server.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        const url = `http://${this.opts.host === '0.0.0.0' ? 'localhost' : this.opts.host}:${port}`;
        log.info(`control panel at ${url}${this.opts.token ? ' (token required)' : ''}`);
        resolve(url);
      });
    });
  }

  close() {
    if (this.stateTimer) clearInterval(this.stateTimer);
    for (const c of this.clients) c.end();
    this.server.close();
  }

  get port(): number {
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : this.opts.port;
  }

  /* ------------------------------------------------------------ routing */

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    try {
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(this.html);
        return;
      }
      if (!path.startsWith('/api/')) throw new HttpError(404, 'not found');
      this.auth(req, url);
      if (path === '/api/events') return this.sse(req, res);
      const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
      const result = await this.route(req.method ?? 'GET', path, url.searchParams, body);
      json(res, 200, result);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.warn(`${req.method} ${path} failed: ${(e as Error).message}`);
      json(res, status, { error: (e as Error).message });
    }
  }

  private auth(req: IncomingMessage, url: URL) {
    if (!this.opts.token) return;
    const h = req.headers.authorization;
    const given = (h?.startsWith('Bearer ') ? h.slice(7) : undefined) ?? url.searchParams.get('token') ?? (req.headers['x-panel-token'] as string | undefined);
    if (given !== this.opts.token) throw new HttpError(401, 'invalid panel token');
  }

  private async route(method: string, path: string, q: URLSearchParams, body: Record<string, unknown>): Promise<unknown> {
    const bot = this.d.bot;
    const key = `${method} ${path}`;
    switch (key) {
      case 'GET /api/state':
        return { ...bot.snapshot(), panel: { startedAt: this.startedAt, configPath: this.opts.configPath } };
      case 'GET /api/trades':
        return this.d.store.trades(clampInt(q.get('limit'), 1, 1000, 200));
      case 'GET /api/equity':
        return equityCurve(this.d.store);
      case 'GET /api/candles': {
        const mint = str(q.get('mint'));
        return bot.candles.get(mint).slice(-clampInt(q.get('limit'), 10, 1000, 240));
      }
      case 'GET /api/logs':
        return recentLogs(clampInt(q.get('limit'), 1, 500, 200), clampInt(q.get('since'), 0, Number.MAX_SAFE_INTEGER, 0));
      case 'POST /api/control': {
        const action = str(body.action);
        if (action === 'start') void bot.start().catch((e) => log.error('bot loop crashed:', (e as Error).message));
        else if (action === 'stop') bot.stop();
        else if (action === 'pause') bot.pause();
        else if (action === 'resume') bot.resume();
        else if (action === 'scan') void bot.scanNow().catch((e) => log.warn('scan failed:', (e as Error).message));
        else throw new HttpError(400, `unknown action ${action}`);
        return { ok: true, running: bot.isRunning, paused: bot.isPaused };
      }
      case 'POST /api/positions/close': {
        const mint = mintOf(body.mint);
        const pct = clampInt(String(body.pct ?? 100), 1, 100, 100);
        await bot.closePosition(mint, pct);
        return { ok: true };
      }
      case 'POST /api/buy': {
        const mint = mintOf(body.mint);
        const sol = Number(body.sol);
        if (!(sol > 0) || sol > 1000) throw new HttpError(400, 'sol must be a positive number');
        const symbol = await bot.manualBuy(mint, sol);
        return { ok: true, symbol };
      }
      case 'POST /api/watch':
        bot.addWatch(mintOf(body.mint));
        return { ok: true };
      case 'DELETE /api/watch':
        bot.removeTracked(mintOf(q.get('mint')));
        return { ok: true };
      case 'POST /api/check': {
        const mint = mintOf(body.mint);
        const r = await this.d.scanner.inspect(mint);
        return { mint, meta: r.meta, pair: r.pair, safety: r.safety };
      }
      case 'GET /api/config':
        return { yaml: existsSync(this.opts.configPath) ? readFileSync(this.opts.configPath, 'utf8') : toYaml(bot.config), config: bot.config, path: this.opts.configPath };
      case 'PUT /api/config':
        return this.saveConfig(body);
      case 'POST /api/backtest':
        return this.backtest(body);
      default:
        throw new HttpError(404, `no route ${key}`);
    }
  }

  private saveConfig(body: Record<string, unknown>) {
    let raw: unknown;
    let yamlText: string;
    if (typeof body.yaml === 'string') {
      yamlText = body.yaml;
      try {
        raw = parseYaml(yamlText) ?? {};
      } catch (e) {
        throw new HttpError(400, `YAML syntax: ${(e as Error).message}`);
      }
    } else if (body.patch && typeof body.patch === 'object') {
      const current = existsSync(this.opts.configPath) ? (parseYaml(readFileSync(this.opts.configPath, 'utf8')) ?? {}) : {};
      raw = deepMerge(current as Record<string, unknown>, body.patch as Record<string, unknown>);
      yamlText = toYaml(raw);
    } else throw new HttpError(400, 'send {yaml} or {patch}');
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid config: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    validateSemantics(parsed.data);
    writeFileSync(this.opts.configPath, yamlText);
    const restartNeeded = parsed.data.loop.candleTimeframeSec !== this.d.bot.config.loop.candleTimeframeSec;
    this.d.bot.updateConfig(parsed.data);
    return { ok: true, config: parsed.data, yaml: yamlText, restartNeeded };
  }

  private async backtest(body: Record<string, unknown>) {
    const cfg = this.d.bot.config;
    const strategyName = (typeof body.strategy === 'string' ? body.strategy : cfg.strategy.name) as BotConfig['strategy']['name'];
    if (!['momentum', 'meanReversion', 'breakout', 'composite'].includes(strategyName)) throw new HttpError(400, 'unknown strategy');
    const tf = clampInt(String(body.timeframe ?? cfg.loop.candleTimeframeSec), 15, 86400, cfg.loop.candleTimeframeSec);
    const limit = clampInt(String(body.limit ?? 1000), 100, 1000, 1000);
    const mint = mintOf(body.mint);
    const pairs = await this.d.dex.getTokenPairs(mint);
    const pair = bestPair(pairs, mint);
    if (!pair) throw new HttpError(404, 'no pool found for that mint');
    const candles = await this.d.gecko.getOhlcv(pair.pairAddress, tf, limit);
    if (candles.length < cfg.loop.warmupCandles + 10) throw new HttpError(400, `only ${candles.length} candles available`);
    const result = runBacktest(candles, cfg, createStrategy(strategyName));
    return { symbol: pair.baseToken.symbol, pool: pair.pairAddress, dex: pair.dexId, timeframe: tf, strategy: strategyName, ...result, trades: result.trades.slice(-50), candles: candles.length, series: candles.map((c) => [c.t, c.c]) };
  }

  /* ---------------------------------------------------------------- SSE */

  private sse(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: state\ndata: ${JSON.stringify(this.d.bot.snapshot())}\n\n`);
    for (const e of recentLogs(100)) res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  private broadcast(event: string, data: unknown) {
    if (!this.clients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`;
    for (const c of this.clients) c.write(payload);
  }
}

/* ------------------------------------------------------------------ utils */

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new HttpError(413, 'body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function str(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'missing parameter');
  return v;
}

function mintOf(v: unknown): string {
  const s = str(v).trim();
  try {
    new PublicKey(s);
  } catch {
    throw new HttpError(400, 'not a valid Solana address');
  }
  return s;
}

function clampInt(v: string | null | undefined, lo: number, hi: number, dflt: number): number {
  const n = v == null || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}

function validateSemantics(cfg: BotConfig) {
  if (cfg.strategy.params.emaFast >= cfg.strategy.params.emaSlow) throw new HttpError(400, 'emaFast must be smaller than emaSlow');
  const ladder = cfg.risk.takeProfitLadder;
  for (let i = 1; i < ladder.length; i++) if (ladder[i].gainPct <= ladder[i - 1].gainPct) throw new HttpError(400, 'takeProfitLadder gainPct must increase');
  if (ladder[ladder.length - 1].sellPct !== 100) throw new HttpError(400, 'last take-profit rung must sell 100%');
}

export function equityCurve(store: Store): { ts: number; pnlSol: number; cumSol: number; symbol: string }[] {
  const trades = store.tradesSince(0).filter((t) => t.side === 'sell');
  let cum = 0;
  return trades.map((t) => {
    cum += t.pnlSol ?? 0;
    return { ts: t.ts, pnlSol: t.pnlSol ?? 0, cumSol: cum, symbol: t.symbol };
  });
}
