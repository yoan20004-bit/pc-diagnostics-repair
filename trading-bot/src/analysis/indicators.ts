import type { Candle } from '../types.js';

export function sma(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(values.length).fill(undefined);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI */
export function rsi(values: number[], period = 14): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(values.length).fill(undefined);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface MacdPoint {
  macd?: number;
  signal?: number;
  hist?: number;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdPoint[] {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (ef[i] !== undefined && es[i] !== undefined) {
      line.push((ef[i] as number) - (es[i] as number));
      idx.push(i);
    }
  }
  const sig = ema(line, signalPeriod);
  const out: MacdPoint[] = values.map(() => ({}));
  line.forEach((m, j) => {
    const s = sig[j];
    out[idx[j]] = { macd: m, signal: s, hist: s === undefined ? undefined : m - s };
  });
  return out;
}

export interface BollingerPoint {
  upper?: number;
  middle?: number;
  lower?: number;
  /** (price - lower) / (upper - lower) */
  pctB?: number;
  /** bandwidth as % of middle */
  width?: number;
}

export function bollinger(values: number[], period = 20, stdDev = 2): BollingerPoint[] {
  const out: BollingerPoint[] = values.map(() => ({}));
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / period;
    const variance = win.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    const upper = mean + stdDev * sd;
    const lower = mean - stdDev * sd;
    out[i] = {
      upper,
      middle: mean,
      lower,
      pctB: upper === lower ? 0.5 : (values[i] - lower) / (upper - lower),
      width: mean ? ((upper - lower) / mean) * 100 : 0,
    };
  }
  return out;
}

export function atr(candles: Candle[], period = 14): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(candles.length).fill(undefined);
  if (candles.length <= period) return out;
  const tr: number[] = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const p = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p));
  });
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function vwap(candles: Candle[], lookback: number): number | undefined {
  const win = candles.slice(-lookback).filter((c) => c.v > 0);
  if (!win.length) return undefined;
  let pv = 0;
  let vol = 0;
  for (const c of win) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vol += c.v;
  }
  return vol ? pv / vol : undefined;
}

/** Rate of change in % over `period` bars. */
export function roc(values: number[], period: number): number | undefined {
  if (values.length <= period) return undefined;
  const a = values[values.length - 1 - period];
  const b = values[values.length - 1];
  return a ? ((b - a) / a) * 100 : undefined;
}

export function highest(values: number[], lookback: number, excludeLast = 1): number | undefined {
  const win = values.slice(-(lookback + excludeLast), values.length - excludeLast);
  return win.length ? Math.max(...win) : undefined;
}

export function lowest(values: number[], lookback: number, excludeLast = 1): number | undefined {
  const win = values.slice(-(lookback + excludeLast), values.length - excludeLast);
  return win.length ? Math.min(...win) : undefined;
}

/** Normalised slope of the last `n` points, in % of the mean per bar. */
export function slopePct(values: (number | undefined)[], n: number): number | undefined {
  const win = values.slice(-n).filter((v): v is number => v !== undefined);
  if (win.length < 2) return undefined;
  const len = win.length;
  const xMean = (len - 1) / 2;
  const yMean = win.reduce((a, b) => a + b, 0) / len;
  let num = 0;
  let den = 0;
  for (let i = 0; i < len; i++) {
    num += (i - xMean) * (win[i] - yMean);
    den += (i - xMean) ** 2;
  }
  if (!den || !yMean) return undefined;
  return ((num / den) / yMean) * 100;
}

export function last<T>(arr: T[], back = 0): T | undefined {
  return arr[arr.length - 1 - back];
}

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.c);
}

export function volumes(candles: Candle[]): number[] {
  return candles.map((c) => c.v);
}
