import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelServer } from '../src/server/panel.js';
import { TradingBot } from '../src/bot.js';
import { Store } from '../src/storage/db.js';
import { PaperExecutor } from '../src/trading/executor.js';
import { PositionManager } from '../src/trading/positions.js';
import { RiskManager } from '../src/trading/risk.js';
import { createStrategy } from '../src/strategies/registry.js';
import { setLogLevel, createLogger } from '../src/logger.js';
import { SOL_MINT } from '../src/utils.js';
import { candlesFrom, cfg } from './helpers.js';
import type { Candidate } from '../src/types.js';
import { Keypair } from '@solana/web3.js';

setLogLevel('error');
const MINT = Keypair.generate().publicKey.toBase58(); // API validates addresses, so use a real one

describe('PanelServer', () => {
  let server: PanelServer;
  let base: string;
  let bot: TradingBot;
  let store: Store;
  const price = { usd: 1 };
  const cfgPath = join(mkdtempSync(join(tmpdir(), 'panel-')), 'config.yaml');

  beforeAll(async () => {
    writeFileSync(cfgPath, 'risk:\n  positionSizeSol: 0.5\n');
    const config = cfg({ loop: { scanIntervalSec: 3600, warmupCandles: 40 }, strategy: { name: 'momentum', minBuyScore: 0.5 }, risk: { positionSizeSol: 0.5, positionSizePct: 50, minSolReserve: 0 } });
    const hist = candlesFrom([...Array.from({ length: 60 }, (_, i) => 0.9 + Math.sin(i) * 0.003), ...Array.from({ length: 10 }, (_, i) => 0.902 + i * 0.0008 - (i % 2) * 0.0003)], Date.now() - 70 * 60_000, 0);
    price.usd = hist.at(-1)!.c;
    const pair = { pairAddress: 'pool', chainId: 'solana', dexId: 'raydium', baseToken: { address: MINT, symbol: 'TST', name: 'Test' }, quoteToken: { address: SOL_MINT, symbol: 'SOL', name: 'SOL' }, priceUsd: price.usd, priceNative: 0.01, liquidityUsd: 1e6, volume: { m5: 1, h1: 1, h6: 1, h24: 1 }, priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, txns: { m5: { buys: 10, sells: 5 }, h1: { buys: 100, sells: 60 }, h6: { buys: 1, sells: 1 }, h24: { buys: 1, sells: 1 } } };
    const candidate: Candidate = { mint: MINT, symbol: 'TST', name: 'Test', decimals: 6, source: ['test'], safetyScore: 90, safetyReasons: [], discoveredAt: Date.now(), pair };
    store = new Store(':memory:');
    const risk = new RiskManager(config.risk);
    const executor = new PaperExecutor((m) => (m === MINT ? bot.priceSolPerRaw(MINT, 6) : undefined), config.execution, undefined, undefined, 2);
    const scanner = { discover: async () => [candidate], inspect: async () => ({ candidate, safety: { ok: true, score: 90, reasons: [], hardFail: [] }, meta: undefined, pair }), setConfig: () => undefined } as never;
    bot = new TradingBot(config, { rpcUrl: '', mode: 'paper', riskAcknowledged: false, dbPath: ':memory:', logLevel: 'error', panel: { enabled: true, host: '127.0.0.1', port: 0 }, configPath: cfgPath }, {
      jup: { getPrices: async () => ({ [SOL_MINT]: { usdPrice: 100, decimals: 9 }, [MINT]: { usdPrice: price.usd, decimals: 6 } }) } as never,
      dex: { getBestPairs: async () => new Map([[MINT, pair]]), getTokenPairs: async () => [pair] } as never,
      gecko: { getOhlcv: async () => hist } as never,
      scanner, store, executor, risk, positions: new PositionManager(config.risk, config.strategy.minSellScore), strategy: createStrategy('momentum'),
      notifier: { send: async () => undefined, enabled: false } as never, walletAddress: 'paper',
    });
    server = new PanelServer({ host: '127.0.0.1', port: 0, token: 'secret', configPath: cfgPath }, { bot, store, scanner, dex: {} as never, gecko: {} as never });
    base = await server.listen();
  });
  afterAll(() => server.close());

  const H = { 'x-panel-token': 'secret', 'content-type': 'application/json' };
  const get = (p: string) => fetch(base + p, { headers: H }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p: string, b: unknown, m = 'POST') => fetch(base + p, { method: m, headers: H, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it('serves the UI and enforces the token', async () => {
    const html = await fetch(base + '/').then((r) => r.text());
    expect(html).toContain('Phantom Bot');
    const denied = await fetch(base + '/api/state');
    expect(denied.status).toBe(401);
    const ok = await get('/api/state');
    expect(ok.status).toBe(200);
    expect(ok.body.mode).toBe('paper');
    expect(ok.body.running).toBe(false);
  });

  it('runs a scan, exposes tracked tokens with signals, and trades via the API', async () => {
    await bot.scanNow();
    await bot.tick(); // evaluates signals (momentum setup) -> paper buy
    const s = await get('/api/state');
    expect(s.body.tracked[0].symbol).toBe('TST');
    expect(s.body.positions).toHaveLength(1);
    expect(s.body.positions[0].gainPct).toBeDefined();
    const closed = await post('/api/positions/close', { mint: MINT, pct: 50 });
    expect(closed.status).toBe(200);
    const s2 = await get('/api/state');
    expect(Number(s2.body.positions[0].amountRaw)).toBeLessThan(Number(s.body.positions[0].amountRaw));
    const trades = await get('/api/trades');
    expect(trades.body.some((t: { side: string }) => t.side === 'sell')).toBe(true);
    const eq = await get('/api/equity');
    expect(eq.body).toHaveLength(1);
  });

  it('pauses, resumes, validates addresses and config edits', async () => {
    expect((await post('/api/control', { action: 'pause' })).body.paused).toBe(true);
    expect((await post('/api/control', { action: 'resume' })).body.paused).toBe(false);
    expect((await post('/api/buy', { mint: 'nope', sol: 1 })).status).toBe(400);
    const bad = await post('/api/config', { yaml: 'risk:\n  stopLossPct: -5\n' }, 'PUT');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/invalid config/);
    const good = await post('/api/config', { patch: { risk: { stopLossPct: 12 } } }, 'PUT');
    expect(good.status).toBe(200);
    expect(good.body.config.risk.stopLossPct).toBe(12);
    expect(good.body.config.risk.positionSizeSol).toBe(0.5); // preserved from file
    expect(bot.config.risk.stopLossPct).toBe(12);
  });

  it('blocks cross-site and non-JSON state changes (CSRF guard)', async () => {
    const plain = await fetch(base + '/api/control', { method: 'POST', headers: { 'x-panel-token': 'secret', 'content-type': 'text/plain' }, body: JSON.stringify({ action: 'pause' }) });
    expect(plain.status).toBe(415);
    const cross = await fetch(base + '/api/control', { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: JSON.stringify({ action: 'pause' }) });
    expect(cross.status).toBe(403);
    const fetchSite = await fetch(base + '/api/state', { headers: { ...H, 'sec-fetch-site': 'cross-site' } });
    expect(fetchSite.status).toBe(403);
    const same = await fetch(base + '/api/control', { method: 'POST', headers: { ...H, origin: base }, body: JSON.stringify({ action: 'resume' }) });
    expect(same.status).toBe(200);
    expect(bot.isPaused).toBe(false);
  });

  it('streams logs over SSE', async () => {
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/events?token=secret', { signal: ctrl.signal });
    const reader = res.body!.getReader();
    createLogger('test').error('hello-from-test');
    let text = '';
    for (let i = 0; i < 20 && !text.includes('hello-from-test'); i++) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    expect(text).toContain('event: state');
    expect(text).toContain('hello-from-test');
  });
});
