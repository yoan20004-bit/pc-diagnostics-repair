import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<LogLevel, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
}

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
let logFile: string | undefined;
let nextId = 1;
const RING_SIZE = 500;
const ring: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function setLogFile(path: string | undefined) {
  logFile = path;
  if (path) mkdirSync(dirname(path), { recursive: true });
}

/** Last N log entries (for the panel). */
export function recentLogs(limit = 200, sinceId = 0): LogEntry[] {
  return ring.filter((e) => e.id > sinceId).slice(-limit);
}

export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function write(level: LogLevel, scope: string, args: unknown[]) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = Date.now();
  const msg = args.map(fmt).join(' ');
  const line = `${new Date(ts).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = `${COLORS[level]}${line}${RESET}`;
  if (level === 'error') console.error(out);
  else console.log(out);
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch {
      /* ignore */
    }
  }
  const entry: LogEntry = { id: nextId++, ts, level, scope, msg };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      /* listener errors never break logging */
    }
  }
}

export function createLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => write('debug', scope, a),
    info: (...a: unknown[]) => write('info', scope, a),
    warn: (...a: unknown[]) => write('warn', scope, a),
    error: (...a: unknown[]) => write('error', scope, a),
  };
}

export type Logger = ReturnType<typeof createLogger>;
