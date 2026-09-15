import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const LadderRung = z.object({ gainPct: z.number().positive(), sellPct: z.number().min(1).max(100) });

export const ConfigSchema = z.object({
  loop: z
    .object({
      pollIntervalSec: z.number().min(5).default(15),
      scanIntervalSec: z.number().min(30).default(180),
      candleTimeframeSec: z.number().min(15).default(60),
      warmupCandles: z.number().min(5).default(40),
      maxCandles: z.number().min(50).default(600),
      fastExitIntervalSec: z.number().min(0).default(4), // extra price checks for open positions only; 0 = off
      staleFeedAlertSec: z.number().min(15).default(90),
    })
    .prefault({}),
  watchlist: z.array(z.string()).default([]),
  blacklist: z.array(z.string()).default([]),
  scanner: z
    .object({
      enabled: z.boolean().default(true),
      sources: z
        .array(z.enum(['jupiter_toptrending', 'jupiter_toporganic', 'jupiter_toptraded', 'dexscreener_boosted']))
        .default(['jupiter_toptrending', 'jupiter_toporganic']),
      interval: z.enum(['5m', '1h', '6h', '24h']).default('1h'),
      maxCandidates: z.number().min(1).max(50).default(15),
      filters: z
        .object({
          minLiquidityUsd: z.number().default(75000),
          minVolume24hUsd: z.number().default(250000),
          minMarketCapUsd: z.number().default(300000),
          maxMarketCapUsd: z.number().default(200_000_000),
          minAgeHours: z.number().default(24),
          minHolders: z.number().default(800),
          minOrganicScore: z.number().default(35),
          requireMintAuthorityDisabled: z.boolean().default(true),
          requireFreezeAuthorityDisabled: z.boolean().default(true),
          maxTopHoldersPct: z.number().default(45),
          allowToken2022: z.boolean().default(false),
          minBuySellRatio1h: z.number().default(0.8),
          maxPriceChange1hPct: z.number().default(60),
          rejectShieldWarnings: z.array(z.string()).default([
            'HAS_MINT_AUTHORITY',
            'HAS_FREEZE_AUTHORITY',
            'HAS_PERMANENT_DELEGATE',
            'TRANSFER_TAX',
            'NOT_SELLABLE',
          ]),
        })
        .prefault({}),
    })
    .prefault({}),
  strategy: z
    .object({
      name: z.enum(['momentum', 'meanReversion', 'breakout', 'composite']).default('composite'),
      minBuyScore: z.number().min(0).max(1).default(0.62),
      minSellScore: z.number().min(0).max(1).default(0.55),
      htf: z
        .object({
          enabled: z.boolean().default(true),
          multiplier: z.number().int().min(2).max(60).default(5), // higher timeframe = multiplier x base candles
          emaFast: z.number().int().min(2).default(9),
          emaSlow: z.number().int().min(3).default(21),
        })
        .prefault({}),
      params: z
        .object({
          emaFast: z.number().int().min(2).default(9),
          emaSlow: z.number().int().min(3).default(21),
          emaTrend: z.number().int().min(5).default(50),
          rsiPeriod: z.number().int().min(2).default(14),
          rsiBuyMin: z.number().default(45),
          rsiBuyMax: z.number().default(68),
          rsiOversold: z.number().default(32),
          rsiOverbought: z.number().default(72),
          bbPeriod: z.number().int().min(5).default(20),
          bbStdDev: z.number().default(2),
          breakoutLookback: z.number().int().min(5).default(30),
          volumeSpikeMultiplier: z.number().default(1.8),
          atrPeriod: z.number().int().min(2).default(14),
          weights: z
            .object({
              momentum: z.number().default(0.45),
              breakout: z.number().default(0.3),
              meanReversion: z.number().default(0.25),
            })
            .prefault({}),
        })
        .prefault({}),
    })
    .prefault({}),
  regime: z
    .object({
      enabled: z.boolean().default(true),
      solEmaPeriod: z.number().int().min(5).default(50), // on higher-timeframe SOL candles
      maxSolDrop1hPct: z.number().positive().default(4),
      solPool: z.string().default('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'), // Raydium SOL/USDC for candle seeding
    })
    .prefault({}),
  risk: z
    .object({
      positionSizeSol: z.number().positive().default(0.25),
      volatility: z
        .object({
          enabled: z.boolean().default(true),
          atrPeriod: z.number().int().min(2).default(14),
          stopAtrMultiple: z.number().positive().default(2.5),
          minStopPct: z.number().positive().default(4),
          maxStopPct: z.number().positive().default(15),
          riskPerTradePct: z.number().positive().default(1), // % of balance lost if the stop is hit
        })
        .prefault({}),
      lockProfitFraction: z.number().min(0).max(1).default(0.5), // after a TP rung, stop moves to rung gain x this
      maxRoundTripLossPct: z.number().positive().default(6), // buy+sell quote loss beyond this = unsellable / taxed
      autoBlacklist: z
        .object({
          enabled: z.boolean().default(true),
          minFills: z.number().int().min(1).default(2),
          maxAvgSlippagePct: z.number().positive().default(3),
        })
        .prefault({}),
      positionSizePct: z.number().positive().max(100).default(10),
      maxOpenPositions: z.number().int().min(1).default(3),
      maxExposureSol: z.number().positive().default(0.75),
      minSolReserve: z.number().min(0).default(0.05),
      stopLossPct: z.number().positive().default(8),
      takeProfitLadder: z.array(LadderRung).min(1).default([
        { gainPct: 12, sellPct: 40 },
        { gainPct: 25, sellPct: 30 },
        { gainPct: 60, sellPct: 100 },
      ]),
      trailingStop: z
        .object({
          enabled: z.boolean().default(true),
          activationPct: z.number().default(10),
          trailPct: z.number().positive().default(6),
        })
        .prefault({}),
      maxHoldMinutes: z.number().positive().default(720),
      maxSlippageBps: z.number().int().positive().default(200),
      maxPriceImpactPct: z.number().positive().default(1.5),
      maxDailyLossPct: z.number().positive().default(5),
      maxTradesPerDay: z.number().int().positive().default(25),
      maxConsecutiveLosses: z.number().int().positive().default(3),
      cooldownAfterLossMin: z.number().min(0).default(20),
      reentryCooldownMin: z.number().min(0).default(60),
    })
    .prefault({}),
  telegram: z
    .object({
      commands: z.boolean().default(true), // accept /status /pause /close ... from the configured chat
    })
    .prefault({}),
  execution: z
    .object({
      engine: z.enum(['ultra', 'swap']).default('ultra'),
      slippageBps: z.number().int().min(1).default(100),
      ultraSlippageBps: z.number().int().min(0).default(0),
      priorityLevel: z.enum(['medium', 'high', 'veryHigh']).default('high'),
      maxPriorityFeeLamports: z.number().int().positive().default(2_000_000),
      confirmTimeoutSec: z.number().positive().default(75),
      retries: z.number().int().min(0).default(2),
      paperSlippageBps: z.number().min(0).default(60),
      paperFeeSol: z.number().min(0).default(0.0015),
    })
    .prefault({}),
});

export type BotConfig = z.infer<typeof ConfigSchema>;
export type StrategyParams = BotConfig['strategy']['params'];
export type RiskConfig = BotConfig['risk'];
export type ScannerFilters = BotConfig['scanner']['filters'];

export interface EnvConfig {
  privateKey?: string;
  rpcUrl: string;
  rpcWsUrl?: string;
  jupiterApiKey?: string;
  mode: 'paper' | 'live';
  riskAcknowledged: boolean;
  telegramToken?: string;
  telegramChatId?: string;
  dbPath: string;
  logLevel: string;
  panel: { enabled: boolean; host: string; port: number; token?: string };
  configPath: string;
}

export function loadEnv(): EnvConfig {
  const mode = (process.env.MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
  return {
    privateKey: process.env.PRIVATE_KEY?.trim() || undefined,
    rpcUrl: process.env.RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com',
    rpcWsUrl: process.env.RPC_WS_URL?.trim() || undefined,
    jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || undefined,
    mode,
    riskAcknowledged: (process.env.I_UNDERSTAND_THE_RISKS || '').trim().toLowerCase() === 'yes',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || undefined,
    dbPath: process.env.DB_PATH || resolve(process.cwd(), 'data/bot.db'),
    logLevel: process.env.LOG_LEVEL || 'info',
    panel: {
      enabled: (process.env.PANEL || 'on').toLowerCase() !== 'off',
      host: process.env.PANEL_HOST || '127.0.0.1',
      port: Number(process.env.PANEL_PORT) || 8787,
      token: process.env.PANEL_TOKEN?.trim() || undefined,
    },
    configPath: resolve(process.cwd(), process.env.CONFIG_PATH || 'config.yaml'),
  };
}

export function loadConfig(path?: string): BotConfig {
  const file = resolve(process.cwd(), path || process.env.CONFIG_PATH || 'config.yaml');
  let raw: unknown = {};
  if (existsSync(file)) {
    raw = parseYaml(readFileSync(file, 'utf8')) ?? {};
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config at ${file}:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.strategy.params.emaFast >= cfg.strategy.params.emaSlow) {
    throw new Error('strategy.params.emaFast must be smaller than emaSlow');
  }
  if (cfg.risk.volatility.minStopPct > cfg.risk.volatility.maxStopPct) throw new Error('risk.volatility.minStopPct must be <= maxStopPct');
  const ladder = cfg.risk.takeProfitLadder;
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i].gainPct <= ladder[i - 1].gainPct) throw new Error('risk.takeProfitLadder gainPct must be increasing');
  }
  if (ladder[ladder.length - 1].sellPct !== 100) {
    throw new Error('risk.takeProfitLadder: the last rung must have sellPct: 100');
  }
  return cfg;
}
