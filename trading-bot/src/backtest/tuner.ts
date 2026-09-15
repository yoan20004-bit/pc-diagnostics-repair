import type { BotConfig } from '../config.js';
import { createStrategy } from '../strategies/registry.js';
import type { Candle } from '../types.js';
import { runBacktest, type BacktestResult } from './engine.js';

export interface TuneCandidate {
  params: Record<string, number>;
  train: { returnPct: number; trades: number; maxDrawdownPct: number; winRatePct: number };
  test: { returnPct: number; trades: number; maxDrawdownPct: number; winRatePct: number };
  /** test-period return penalised by drawdown; the ranking key */
  score: number;
}

export interface TuneResult {
  strategy: string;
  candleSets: number;
  trainFraction: number;
  combosTried: number;
  elapsedMs: number;
  best?: TuneCandidate;
  baseline: TuneCandidate;
  top: TuneCandidate[];
  /** config patch to apply the best parameters */
  patch?: Record<string, unknown>;
}

export interface TuneOptions {
  strategy?: BotConfig['strategy']['name'];
  trainFraction?: number;
  minTrades?: number;
  maxCombos?: number;
  timeBudgetMs?: number;
  grid?: Record<string, number[]>;
  /** yield to the event loop between combos so a live bot keeps ticking */
  yieldEvery?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Default search space. Keys map onto config paths below. */
export const DEFAULT_GRID: Record<string, number[]> = {
  emaFast: [5, 9, 13],
  emaSlow: [21, 34],
  rsiBuyMax: [65, 72],
  minBuyScore: [0.55, 0.62, 0.7],
  stopLossPct: [5, 8, 12],
  trailPct: [4, 6, 9],
  stopAtrMultiple: [2, 3],
};

const PATHS: Record<string, (cfg: BotConfig, v: number) => void> = {
  emaFast: (c, v) => (c.strategy.params.emaFast = v),
  emaSlow: (c, v) => (c.strategy.params.emaSlow = v),
  emaTrend: (c, v) => (c.strategy.params.emaTrend = v),
  rsiBuyMax: (c, v) => (c.strategy.params.rsiBuyMax = v),
  rsiOversold: (c, v) => (c.strategy.params.rsiOversold = v),
  breakoutLookback: (c, v) => (c.strategy.params.breakoutLookback = v),
  minBuyScore: (c, v) => (c.strategy.minBuyScore = v),
  stopLossPct: (c, v) => (c.risk.stopLossPct = v),
  trailPct: (c, v) => (c.risk.trailingStop.trailPct = v),
  trailActivationPct: (c, v) => (c.risk.trailingStop.activationPct = v),
  stopAtrMultiple: (c, v) => (c.risk.volatility.stopAtrMultiple = v),
  lockProfitFraction: (c, v) => (c.risk.lockProfitFraction = v),
};

export function applyParams(base: BotConfig, params: Record<string, number>): BotConfig {
  const cfg = structuredClone(base);
  for (const [k, v] of Object.entries(params)) PATHS[k]?.(cfg, v);
  return cfg;
}

export function paramsToPatch(params: Record<string, number>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const set = (path: string[], v: number) => {
    let o = patch;
    for (const k of path.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
    o[path[path.length - 1]] = v;
  };
  const map: Record<string, string[]> = {
    emaFast: ['strategy', 'params', 'emaFast'],
    emaSlow: ['strategy', 'params', 'emaSlow'],
    emaTrend: ['strategy', 'params', 'emaTrend'],
    rsiBuyMax: ['strategy', 'params', 'rsiBuyMax'],
    rsiOversold: ['strategy', 'params', 'rsiOversold'],
    breakoutLookback: ['strategy', 'params', 'breakoutLookback'],
    minBuyScore: ['strategy', 'minBuyScore'],
    stopLossPct: ['risk', 'stopLossPct'],
    trailPct: ['risk', 'trailingStop', 'trailPct'],
    trailActivationPct: ['risk', 'trailingStop', 'activationPct'],
    stopAtrMultiple: ['risk', 'volatility', 'stopAtrMultiple'],
    lockProfitFraction: ['risk', 'lockProfitFraction'],
  };
  for (const [k, v] of Object.entries(params)) if (map[k]) set(map[k], v);
  return patch;
}

function combos(grid: Record<string, number[]>): Record<string, number>[] {
  const keys = Object.keys(grid);
  let out: Record<string, number>[] = [{}];
  for (const k of keys) out = out.flatMap((o) => grid[k].map((v) => ({ ...o, [k]: v })));
  return out.filter((o) => !(o.emaFast !== undefined && o.emaSlow !== undefined && o.emaFast >= o.emaSlow));
}

function summarise(r: BacktestResult) {
  return { returnPct: r.returnPct, trades: r.trades.length, maxDrawdownPct: r.maxDrawdownPct, winRatePct: r.winRatePct };
}

/** Deterministic shuffle so a capped search still samples the whole grid evenly. */
function shuffle<T>(arr: T[], seed = 12345): T[] {
  const a = [...arr];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Walk-forward parameter search. Each candle set is split into a training part and a
 * later test part; parameters are ranked ONLY by out-of-sample (test) performance,
 * averaged across sets and penalised by drawdown, so the winner is not just curve-fit.
 */
export async function tune(candleSets: Candle[][], base: BotConfig, opts: TuneOptions = {}): Promise<TuneResult> {
  const started = Date.now();
  const strategyName = opts.strategy ?? base.strategy.name;
  const trainFraction = opts.trainFraction ?? 0.7;
  const minTrades = opts.minTrades ?? 4;
  const grid = opts.grid ?? DEFAULT_GRID;
  const all = shuffle(combos(grid));
  const list = all.slice(0, opts.maxCombos ?? 400);
  const splits = candleSets.map((c) => ({ train: c.slice(0, Math.floor(c.length * trainFraction)), test: c.slice(Math.max(0, Math.floor(c.length * trainFraction) - base.loop.warmupCandles)) }));

  const evaluate = (params: Record<string, number>): TuneCandidate => {
    const cfg = applyParams(base, params);
    const strat = createStrategy(strategyName);
    const tr: ReturnType<typeof summarise>[] = [];
    const te: ReturnType<typeof summarise>[] = [];
    for (const s of splits) {
      tr.push(summarise(runBacktest(s.train, cfg, strat)));
      te.push(summarise(runBacktest(s.test, cfg, strat)));
    }
    const avg = (xs: ReturnType<typeof summarise>[]) => ({
      returnPct: xs.reduce((a, x) => a + x.returnPct, 0) / xs.length,
      trades: xs.reduce((a, x) => a + x.trades, 0),
      maxDrawdownPct: Math.max(...xs.map((x) => x.maxDrawdownPct)),
      winRatePct: xs.reduce((a, x) => a + x.winRatePct, 0) / xs.length,
    });
    const train = avg(tr);
    const test = avg(te);
    const enough = test.trades >= minTrades;
    const score = enough ? test.returnPct - test.maxDrawdownPct * 0.5 : -Infinity;
    return { params, train, test, score };
  };

  const baseline = evaluate({});
  const results: TuneCandidate[] = [];
  let done = 0;
  for (const params of list) {
    if (opts.timeBudgetMs && Date.now() - started > opts.timeBudgetMs) break;
    results.push(evaluate(params));
    done++;
    opts.onProgress?.(done, list.length);
    if (done % (opts.yieldEvery ?? 3) === 0) await new Promise((r) => setImmediate(r));
  }
  results.sort((a, b) => b.score - a.score);
  const best = results[0] && results[0].score > baseline.score && results[0].score > -Infinity ? results[0] : undefined;
  return {
    strategy: strategyName,
    candleSets: candleSets.length,
    trainFraction,
    combosTried: done,
    elapsedMs: Date.now() - started,
    best,
    baseline,
    top: results.slice(0, 10),
    patch: best ? paramsToPatch(best.params) : undefined,
  };
}
