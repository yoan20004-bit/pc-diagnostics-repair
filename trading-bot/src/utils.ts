export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const LAMPORTS = 1_000_000_000;
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function nowMs() {
  return Date.now();
}

export function toRaw(amount: number, decimals: number): bigint {
  // avoid float precision issues by working in string space
  const [intPart, fracPart = ''] = amount.toFixed(Math.min(decimals, 20)).split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(intPart + frac);
}

export function fromRaw(raw: bigint | string | number, decimals: number): number {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return Number(`${int}.${frac}`);
}

export function pct(a: number, b: number): number {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function fmtNum(n: number | undefined, digits = 4): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '-';
  if (Math.abs(n) >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  if (Math.abs(n) < 0.0001 && n !== 0) return n.toExponential(3);
  return n.toFixed(digits);
}

export function fmtPct(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function shortMint(m: string) {
  return m.length > 12 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m;
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Simple token bucket rate limiter (requests per minute). */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  constructor(private perMinute: number) {
    this.tokens = perMinute;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) / 60000) * this.perMinute);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.perMinute) * 60000));
    }
  }
}

export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  limiter?: RateLimiter;
}

export class HttpError extends Error {
  constructor(public status: number, public body: string, public url: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
  }
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 15000, retries = 2, limiter, ...init } = opts;
  let attempt = 0;
  for (;;) {
    if (limiter) await limiter.take();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          attempt++;
          const ra = Number(res.headers.get('retry-after'));
          await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
          continue;
        }
        throw new HttpError(res.status, text, url);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (attempt < retries) {
        attempt++;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
