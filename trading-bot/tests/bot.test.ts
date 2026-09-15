import { describe, expect, it } from 'vitest';
import { TradingBot } from '../src/bot.js';
import { Store } from '../src/storage/db.js';
import { PaperExecutor } from '../src/trading/executor.js';
import { PositionManager } from '../src/trading/positions.js';
import { RiskManager } from '../src/trading/risk.js';
import { createStrategy } from '../src/strategies/registry.js';
import { setLogLevel } from '../src/logger.js';
import { SOL_MINT } from '../src/utils.js';
import { candlesFrom, cfg } from './helpers.js';
import type { Candidate } from '../src/types.js';

setLogLevel('error');

/**
 * End-to-end paper run with mocked market data: the bot must open a position on a
 * strong momentum setup and close it when the price collapses through the stop.
 */
describe('TradingBot (paper, mocked market)', () => {
  it('buys on signal and sells on stop-loss', async () => {
    const config = cfg({
      loop: { pollIntervalSec: 5, scanIntervalSec: 3600, warmupCandles: 40 },
      strategy: { name: 'momentum', minBuyScore: 0.5 },
      risk: { positionSizeSol: 0.5, positionSizePct: 50, stopLossPct: 8, maxDailyLossPct: 90, minSolReserve: 0 },
    });
    const MINT = 'TokenMint111111111111111111111111111111111';
    const price = { usd: 1 };
    const solUsd = 100;
    // history: base then a clean rise -> momentum setup
    const hist = candlesFrom([...Array.from({ length: 60 }, (_, i) => 0.9 + Math.sin(i) * 0.003), ...Array.from({ length: 10 }, (_, i) => 0.902 + i * 0.0008 - (i % 2) * 0.0003)], Date.now() - 70 * 60_000, 0);
    price.usd = hist.at(-1)!.c;

    const candidate: Candidate = { mint: MINT, symbol: 'TST', name: 'Test', decimals: 6, source: ['test'], safetyScore: 90, safetyReasons: [], discoveredAt: Date.now(), pair: { pairAddress: 'pool', chainId: 'solana', dexId: 'raydium', baseToken: { address: MINT, symbol: 'TST', name: 'Test' }, quoteToken: { address: SOL_MINT, symbol: 'SOL', name: 'SOL' }, priceUsd: price.usd, priceNative: 0.01, liquidityUsd: 1e6, volume: { m5: 1, h1: 1, h6: 1, h24: 1 }, priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, txns: { m5: { buys: 10, sells: 5 }, h1: { buys: 100, sells: 60 }, h6: { buys: 1, sells: 1 }, h24: { buys: 1, sells: 1 } } } };

    const store = new Store(':memory:');
    const risk = new RiskManager(config.risk);
    let bot: TradingBot;
    const executor = new PaperExecutor((m) => (m === MINT ? bot.priceSolPerRaw(MINT, 6) : undefined), config.execution, undefined, undefined, 2);
    const sent: string[] = [];
    bot = new TradingBot(config, { rpcUrl: '', mode: 'paper', riskAcknowledged: false, dbPath: ':memory:', logLevel: 'error' }, {
      jup: { getPrices: async () => ({ [SOL_MINT]: { usdPrice: solUsd, decimals: 9 }, [MINT]: { usdPrice: price.usd, decimals: 6 } }) } as never,
      dex: { getBestPairs: async () => new Map([[MINT, candidate.pair!]]), getTokenPairs: async () => [candidate.pair!] } as never,
      gecko: { getOhlcv: async () => hist } as never,
      scanner: { discover: async () => [candidate] } as never,
      store,
      executor,
      risk,
      positions: new PositionManager(config.risk, config.strategy.minSellScore),
      strategy: createStrategy('momentum'),
      notifier: { send: async (t: string) => void sent.push(t), enabled: false } as never,
      walletAddress: 'paper',
    });

    await bot.tick(); // scan + seed + evaluate -> buy
    expect(bot.openPositions).toHaveLength(1);
    const p = bot.openPositions[0];
    expect(p.symbol).toBe('TST');
    expect(p.costSol).toBeGreaterThan(0.4);
    expect(store.trades().some((t) => t.side === 'buy')).toBe(true);
    expect(sent.join(' ')).toMatch(/BOUGHT/);

    price.usd = p.entryPriceUsd * 0.9; // -10% -> stop
    await bot.tick();
    expect(bot.openPositions).toHaveLength(0);
    const sell = store.trades().find((t) => t.side === 'sell')!;
    expect(sell.reason).toMatch(/stop-loss/);
    expect(sell.pnlSol!).toBeLessThan(0);
    expect(risk.state.consecutiveLosses).toBe(1);
    expect(await executor.tokenBalance(MINT)).toBe(0n);
  });
});
