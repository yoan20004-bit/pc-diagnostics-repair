import type { BotConfig } from '../config.js';
import { PositionManager } from '../trading/positions.js';
import { RiskManager } from '../trading/risk.js';
import type { Strategy } from '../strategies/base.js';
import { atrPct, withFilters } from '../strategies/filters.js';
import type { Candle, Position } from '../types.js';

export interface BacktestTrade {
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  sizeQuote: number;
  pnlQuote: number;
  pnlPct: number;
  reason: string;
  bars: number;
}

export interface BacktestResult {
  candles: number;
  startingEquity: number;
  finalEquity: number;
  returnPct: number;
  trades: BacktestTrade[];
  wins: number;
  losses: number;
  winRatePct: number;
  profitFactor: number;
  avgWinPct: number;
  avgLossPct: number;
  maxDrawdownPct: number;
  buyAndHoldPct: number;
  exposureBars: number;
}

export interface BacktestOptions {
  startingEquity?: number;
  /** fraction of equity per trade (0..1) */
  sizeFraction?: number;
  feeBps?: number; // round-trip fees + slippage in bps
  /** candles of history handed to the strategy per bar (keeps the run O(n)) */
  lookback?: number;
}

/**
 * Event-driven backtest over historical candles. Uses the same strategy and
 * PositionManager exit rules as the live bot. Stops are checked against the bar
 * low (pessimistic), signals/take-profits against the bar close.
 */
export function runBacktest(candles: Candle[], cfg: BotConfig, baseStrategy: Strategy, opts: BacktestOptions = {}): BacktestResult {
  const startingEquity = opts.startingEquity ?? 1;
  const sizeFraction = Math.min(1, opts.sizeFraction ?? cfg.risk.positionSizePct / 100);
  const fee = (opts.feeBps ?? 80) / 10_000 / 2; // per side
  const lookback = Math.max(opts.lookback ?? 300, cfg.strategy.params.emaTrend * 3, cfg.strategy.htf.multiplier * (cfg.strategy.htf.emaSlow + 3));
  const pm = new PositionManager(cfg.risk, cfg.strategy.minSellScore);
  const rm = new RiskManager(cfg.risk);
  const strategy = withFilters(baseStrategy, cfg);
  const warm = Math.max(cfg.loop.warmupCandles, 30);

  let equity = startingEquity;
  let peak = equity;
  let maxDd = 0;
  let pos: (Position & { units: number; entryIdx: number; size: number }) | undefined;
  const trades: BacktestTrade[] = [];
  let exposureBars = 0;

  const closeAt = (i: number, price: number, fraction: number, reason: string, ladder: boolean) => {
    if (!pos) return;
    const units = pos.units * fraction;
    const proceeds = units * price * (1 - fee);
    const cost = pos.costSol * fraction;
    equity += proceeds;
    const pnl = proceeds - cost;
    trades.push({
      entryTs: candles[pos.entryIdx].t,
      exitTs: candles[i].t,
      entryPrice: pos.entryPriceSol,
      exitPrice: price,
      sizeQuote: cost,
      pnlQuote: pnl,
      pnlPct: cost ? (pnl / cost) * 100 : 0,
      reason,
      bars: i - pos.entryIdx,
    });
    pos.units -= units;
    pos.costSol -= cost;
    pos.realisedSol += proceeds;
    if (ladder) pos.ladderDone += 1;
    if (fraction >= 1 || pos.units <= 1e-12) pos = undefined;
  };

  for (let i = warm; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i + 1 - lookback), i + 1);
    const bar = candles[i];
    if (pos) {
      exposureBars++;
      // pessimistic intrabar stop check
      const stopPct = pm.stopLevelPct(pos);
      const stopPrice = pos.entryPriceSol * (1 + stopPct / 100);
      if (bar.l <= stopPrice && bar.o > stopPrice) {
        closeAt(i, stopPrice, 1, pos.ladderDone > 0 ? 'breakeven stop (intrabar)' : 'stop-loss (intrabar)', false);
      } else {
        const sig = strategy.evaluate({ candles: window, params: cfg.strategy.params, position: pos });
        const d = pm.checkExit(pos, bar.c, sig, bar.t);
        if (d) closeAt(i, bar.c, d.sellPct / 100, `${d.kind}: ${d.reason}`, d.kind === 'takeProfit');
      }
    }
    if (!pos) {
      const sig = strategy.evaluate({ candles: window, params: cfg.strategy.params });
      if (sig.action === 'buy' && sig.score >= cfg.strategy.minBuyScore) {
        const stopPct = rm.stopPctFor(atrPct(window, cfg.risk.volatility.atrPeriod));
        let size = equity * sizeFraction;
        if (cfg.risk.volatility.enabled) size = Math.min(size, (equity * cfg.risk.volatility.riskPerTradePct) / 100 / (stopPct / 100));
        if (size > 0) {
          const price = bar.c * (1 + fee);
          const units = size / price;
          equity -= size;
          pos = {
            id: `bt-${i}`, mint: 'bt', symbol: 'BT', decimals: 0, amountRaw: '0', costSol: size, entryPriceSol: price, entryPriceUsd: price,
            openedAt: bar.t, highWaterMarkSol: price, ladderDone: 0, realisedSol: 0, strategy: sig.strategy, status: 'open', stopPct, units, entryIdx: i, size,
          };
        }
      }
    }
    const mark = equity + (pos ? pos.units * bar.c : 0);
    peak = Math.max(peak, mark);
    maxDd = Math.max(maxDd, peak ? ((peak - mark) / peak) * 100 : 0);
  }
  if (pos) closeAt(candles.length - 1, candles[candles.length - 1].c, 1, 'end of data', false);

  const wins = trades.filter((t) => t.pnlQuote > 0);
  const losses = trades.filter((t) => t.pnlQuote <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlQuote, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlQuote, 0));
  const first = candles[warm]?.c ?? candles[0].c;
  const lastC = candles[candles.length - 1].c;
  return {
    candles: candles.length,
    startingEquity,
    finalEquity: equity,
    returnPct: ((equity - startingEquity) / startingEquity) * 100,
    trades,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWinPct: wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0,
    avgLossPct: losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0,
    maxDrawdownPct: maxDd,
    buyAndHoldPct: first ? ((lastC - first) / first) * 100 : 0,
    exposureBars,
  };
}

export function parseCandlesCsv(text: string): Candle[] {
  const lines = text.trim().split(/\r?\n/);
  const out: Candle[] = [];
  for (const line of lines) {
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 5 || !/^\d/.test(parts[0])) continue;
    const t = Number(parts[0]);
    out.push({ t: t < 1e12 ? t * 1000 : t, o: +parts[1], h: +parts[2], l: +parts[3], c: +parts[4], v: parts[5] ? +parts[5] : 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}
