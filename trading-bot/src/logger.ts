import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<LogLevel, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
let logFile: string | undefined;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function setLogFile(path: string | undefined) {
  logFile = path;
  if (path) mkdirSync(dirname(path), { recursive: true });
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
  const ts = new Date().toISOString();
  const msg = args.map(fmt).join(' ');
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
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
