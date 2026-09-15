import type { BotConfig } from '../config.js';
import { aggregateCandles } from '../strategies/filters.js';
import type { Candle, RegimeStatus } from '../types.js';
import { closes, ema, last } from './indicators.js';

/**
 * Market regime from SOL itself: no new entries while SOL trades below its higher-timeframe
 * EMA or has dropped sharply in the last hour. Memecoins rarely rally against a falling SOL.
 */
export function assessRegime(solCandles: Candle[], cfg: BotConfig, baseTimeframeSec: number, now = Date.now()): RegimeStatus {
  if (!cfg.regime.enabled) return { ok: true, reason: 'regime filter disabled', checkedAt: now };
  const price = solCandles[solCandles.length - 1]?.c;
  if (!price) return { ok: true, reason: 'no SOL data yet', checkedAt: now };
  const barsPerHour = Math.max(1, Math.round(3600 / baseTimeframeSec));
  const hourAgo = solCandles[Math.max(0, solCandles.length - 1 - barsPerHour)]?.c;
  const change1h = hourAgo ? ((price - hourAgo) / hourAgo) * 100 : undefined;
  if (change1h !== undefined && change1h <= -cfg.regime.maxSolDrop1hPct) {
    return { ok: false, reason: `SOL down ${change1h.toFixed(1)}% in the last hour`, solPrice: price, solChange1hPct: change1h, checkedAt: now };
  }
  const agg = aggregateCandles(solCandles, cfg.strategy.htf.multiplier);
  const c = closes(agg);
  if (c.length < cfg.regime.solEmaPeriod + 1) {
    return { ok: true, reason: `SOL history short (${c.length}/${cfg.regime.solEmaPeriod + 1} bars), trend check skipped`, solPrice: price, solChange1hPct: change1h, checkedAt: now };
  }
  const e = last(ema(c, cfg.regime.solEmaPeriod)) as number;
  if (price < e) {
    return { ok: false, reason: `SOL $${price.toFixed(2)} below its ${cfg.regime.solEmaPeriod}-bar EMA ($${e.toFixed(2)})`, solPrice: price, solEma: e, solChange1hPct: change1h, checkedAt: now };
  }
  return { ok: true, reason: `SOL above EMA ($${e.toFixed(2)}), 1h ${change1h === undefined ? '?' : (change1h >= 0 ? '+' : '') + change1h.toFixed(1) + '%'}`, solPrice: price, solEma: e, solChange1hPct: change1h, checkedAt: now };
}
