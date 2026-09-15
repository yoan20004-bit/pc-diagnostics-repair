import type { Candle } from '../types.js';
import { RateLimiter, fetchJson } from '../utils.js';

/**
 * GeckoTerminal public API: free OHLCV history for any Solana pool (30 req/min, no key).
 * Used to bootstrap candles so strategies can trade immediately instead of waiting for warmup.
 */
export class GeckoTerminalClient {
  private limiter = new RateLimiter(25);

  async getOhlcv(poolAddress: string, timeframeSec: number, limit = 300): Promise<Candle[]> {
    const { tf, agg } = pickTimeframe(timeframeSec);
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/${tf}?aggregate=${agg}&limit=${Math.min(limit, 1000)}&currency=usd`;
    const res = await fetchJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(url, {
      limiter: this.limiter,
      headers: { accept: 'application/json;version=20230302' },
    });
    const list = res.data?.attributes?.ohlcv_list ?? [];
    return list
      .map(([ts, o, h, l, c, v]) => ({ t: ts * 1000, o, h, l, c, v }))
      .filter((c) => Number.isFinite(c.c) && c.c > 0)
      .sort((a, b) => a.t - b.t);
  }
}

function pickTimeframe(sec: number): { tf: 'minute' | 'hour' | 'day'; agg: number } {
  if (sec < 3600) {
    const m = Math.max(1, Math.round(sec / 60));
    const agg = [1, 5, 15].reduce((best, a) => (Math.abs(a - m) < Math.abs(best - m) ? a : best), 1);
    return { tf: 'minute', agg };
  }
  if (sec < 86400) {
    const h = Math.max(1, Math.round(sec / 3600));
    const agg = [1, 4, 12].reduce((best, a) => (Math.abs(a - h) < Math.abs(best - h) ? a : best), 1);
    return { tf: 'hour', agg };
  }
  return { tf: 'day', agg: 1 };
}
