import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { Position, Trade } from '../types.js';

// Loaded lazily so the CLI can install its warning filter before Node prints the experimental-SQLite notice.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/**
 * Persistence on Node's built-in SQLite (no native build step).
 * Tables: positions, trades, kv (json blobs for risk/paper state).
 */
export class Store {
  private db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY, mint TEXT NOT NULL, symbol TEXT, decimals INTEGER NOT NULL,
        amount_raw TEXT NOT NULL, cost_sol REAL NOT NULL, entry_price_sol REAL NOT NULL, entry_price_usd REAL NOT NULL,
        opened_at INTEGER NOT NULL, hwm_sol REAL NOT NULL, ladder_done INTEGER NOT NULL DEFAULT 0,
        realised_sol REAL NOT NULL DEFAULT 0, strategy TEXT, status TEXT NOT NULL, closed_at INTEGER, close_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT, position_id TEXT NOT NULL, mint TEXT NOT NULL, symbol TEXT,
        side TEXT NOT NULL, amount_raw TEXT NOT NULL, sol REAL NOT NULL, price_sol REAL NOT NULL, price_usd REAL NOT NULL,
        fee_sol REAL NOT NULL, signature TEXT, reason TEXT, mode TEXT NOT NULL, ts INTEGER NOT NULL, pnl_sol REAL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.migrate();
  }

  /** Additive schema upgrades for databases created by earlier versions. */
  private migrate() {
    const cols = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)));
    const add = (table: string, col: string, type: string) => {
      if (!cols(table).has(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    };
    add('positions', 'stop_pct', 'REAL');
    add('trades', 'expected_price_sol', 'REAL');
    add('trades', 'slippage_pct', 'REAL');
    add('trades', 'exit_kind', 'TEXT');
  }

  /* ---------------- positions ---------------- */

  upsertPosition(p: Position) {
    this.db
      .prepare(
        `INSERT INTO positions (id, mint, symbol, decimals, amount_raw, cost_sol, entry_price_sol, entry_price_usd, opened_at, hwm_sol,
          ladder_done, realised_sol, strategy, status, closed_at, close_reason, stop_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET amount_raw=excluded.amount_raw, cost_sol=excluded.cost_sol, hwm_sol=excluded.hwm_sol,
           ladder_done=excluded.ladder_done, realised_sol=excluded.realised_sol, status=excluded.status,
           closed_at=excluded.closed_at, close_reason=excluded.close_reason, entry_price_sol=excluded.entry_price_sol,
           entry_price_usd=excluded.entry_price_usd, stop_pct=excluded.stop_pct`,
      )
      .run(
        p.id, p.mint, p.symbol, p.decimals, p.amountRaw, p.costSol, p.entryPriceSol, p.entryPriceUsd, p.openedAt, p.highWaterMarkSol,
        p.ladderDone, p.realisedSol, p.strategy, p.status, p.closedAt ?? null, p.closeReason ?? null, p.stopPct ?? null,
      );
  }

  openPositions(): Position[] {
    return (this.db.prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at`).all() as Row[]).map(rowToPosition);
  }

  recentClosedPositions(limit = 20): Position[] {
    return (this.db.prepare(`SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?`).all(limit) as Row[]).map(rowToPosition);
  }

  /* ---------------- trades ---------------- */

  insertTrade(t: Trade): number {
    const res = this.db
      .prepare(
        `INSERT INTO trades (position_id, mint, symbol, side, amount_raw, sol, price_sol, price_usd, fee_sol, signature, reason, mode, ts, pnl_sol,
          expected_price_sol, slippage_pct, exit_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.positionId, t.mint, t.symbol, t.side, t.amountRaw, t.sol, t.priceSol, t.priceUsd, t.feeSol, t.signature ?? null, t.reason, t.mode, t.ts, t.pnlSol ?? null,
        t.expectedPriceSol ?? null, t.slippagePct ?? null, t.exitKind ?? null);
    return Number(res.lastInsertRowid);
  }

  /** Realised PnL (SOL) and original cost for one position, derived from its trades. */
  positionPnl(positionId: string): { pnlSol: number; costSol: number } {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(CASE WHEN side='sell' THEN pnl_sol ELSE 0 END),0) AS pnl, COALESCE(SUM(CASE WHEN side='buy' THEN sol ELSE 0 END),0) AS cost FROM trades WHERE position_id = ?`)
      .get(positionId) as Row;
    return { pnlSol: Number(r.pnl), costSol: Number(r.cost) };
  }

  trades(limit = 50): Trade[] {
    return (this.db.prepare(`SELECT * FROM trades ORDER BY ts DESC LIMIT ?`).all(limit) as Row[]).map(rowToTrade);
  }

  tradesSince(ts: number): Trade[] {
    return (this.db.prepare(`SELECT * FROM trades WHERE ts >= ? ORDER BY ts`).all(ts) as Row[]).map(rowToTrade);
  }

  stats(): { trades: number; sells: number; wins: number; pnlSol: number; feesSol: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS trades, SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END) AS sells,
                SUM(CASE WHEN side='sell' AND pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
                COALESCE(SUM(pnl_sol),0) AS pnl, COALESCE(SUM(fee_sol),0) AS fees FROM trades`,
      )
      .get() as Row;
    return { trades: Number(r.trades), sells: Number(r.sells ?? 0), wins: Number(r.wins ?? 0), pnlSol: Number(r.pnl), feesSol: Number(r.fees) };
  }

  /** Average execution shortfall per token and overall. */
  slippageStats(): { overallPct: number; fills: number; byMint: Record<string, { symbol: string; avgPct: number; fills: number }> } {
    const rows = this.db
      .prepare(`SELECT mint, symbol, AVG(slippage_pct) AS avg, COUNT(*) AS n FROM trades WHERE slippage_pct IS NOT NULL GROUP BY mint`)
      .all() as Row[];
    const all = this.db.prepare(`SELECT AVG(slippage_pct) AS avg, COUNT(*) AS n FROM trades WHERE slippage_pct IS NOT NULL`).get() as Row;
    const byMint: Record<string, { symbol: string; avgPct: number; fills: number }> = {};
    for (const r of rows) byMint[String(r.mint)] = { symbol: String(r.symbol ?? ''), avgPct: Number(r.avg), fills: Number(r.n) };
    return { overallPct: Number(all.avg ?? 0), fills: Number(all.n ?? 0), byMint };
  }

  /** Performance breakdowns for the analytics tab. */
  analytics(): {
    byStrategy: Breakdown[];
    byExitKind: Breakdown[];
    byToken: Breakdown[];
    byHour: Breakdown[];
    bySource: Breakdown[];
  } {
    const q = (label: string, sql: string) =>
      (this.db.prepare(sql).all() as Row[]).map((r) => ({
        key: String(r.k ?? label),
        trades: Number(r.n),
        wins: Number(r.wins ?? 0),
        pnlSol: Number(r.pnl ?? 0),
        avgPnlPct: Number(r.avgpct ?? 0),
      }));
    const base = `SELECT %K% AS k, COUNT(*) AS n, SUM(CASE WHEN t.pnl_sol > 0 THEN 1 ELSE 0 END) AS wins, SUM(t.pnl_sol) AS pnl,
      AVG(CASE WHEN t.sol - t.pnl_sol > 0 THEN t.pnl_sol / (t.sol - t.pnl_sol) * 100 ELSE 0 END) AS avgpct
      FROM trades t LEFT JOIN positions p ON p.id = t.position_id WHERE t.side = 'sell' GROUP BY k ORDER BY pnl DESC`;
    return {
      byStrategy: q('?', base.replace('%K%', `COALESCE(p.strategy, 'unknown')`)),
      byExitKind: q('?', base.replace('%K%', `COALESCE(t.exit_kind, 'unknown')`)),
      byToken: q('?', base.replace('%K%', `t.symbol`)),
      byHour: q('?', base.replace('%K%', `strftime('%H', t.ts / 1000, 'unixepoch')`).replace('ORDER BY pnl DESC', 'ORDER BY k')),
      bySource: q('?', base.replace('%K%', `t.mode`)),
    };
  }

  /* ---------------- kv ---------------- */

  getJson<T>(key: string): T | undefined {
    const r = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as Row | undefined;
    return r ? (JSON.parse(String(r.value)) as T) : undefined;
  }

  setJson(key: string, value: unknown) {
    this.db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
  }

  close() {
    this.db.close();
  }
}

type Row = Record<string, unknown>;

export interface Breakdown {
  key: string;
  trades: number;
  wins: number;
  pnlSol: number;
  avgPnlPct: number;
}

function rowToPosition(r: Row): Position {
  return {
    id: String(r.id),
    mint: String(r.mint),
    symbol: String(r.symbol ?? ''),
    decimals: Number(r.decimals),
    amountRaw: String(r.amount_raw),
    costSol: Number(r.cost_sol),
    entryPriceSol: Number(r.entry_price_sol),
    entryPriceUsd: Number(r.entry_price_usd),
    openedAt: Number(r.opened_at),
    highWaterMarkSol: Number(r.hwm_sol),
    ladderDone: Number(r.ladder_done),
    realisedSol: Number(r.realised_sol),
    strategy: String(r.strategy ?? ''),
    status: r.status === 'open' ? 'open' : 'closed',
    closedAt: r.closed_at == null ? undefined : Number(r.closed_at),
    closeReason: r.close_reason == null ? undefined : String(r.close_reason),
    stopPct: r.stop_pct == null ? undefined : Number(r.stop_pct),
  };
}

function rowToTrade(r: Row): Trade {
  return {
    id: Number(r.id),
    positionId: String(r.position_id),
    mint: String(r.mint),
    symbol: String(r.symbol ?? ''),
    side: r.side === 'buy' ? 'buy' : 'sell',
    amountRaw: String(r.amount_raw),
    sol: Number(r.sol),
    priceSol: Number(r.price_sol),
    priceUsd: Number(r.price_usd),
    feeSol: Number(r.fee_sol),
    signature: r.signature == null ? undefined : String(r.signature),
    reason: String(r.reason ?? ''),
    mode: r.mode === 'live' ? 'live' : 'paper',
    ts: Number(r.ts),
    pnlSol: r.pnl_sol == null ? undefined : Number(r.pnl_sol),
    expectedPriceSol: r.expected_price_sol == null ? undefined : Number(r.expected_price_sol),
    slippagePct: r.slippage_pct == null ? undefined : Number(r.slippage_pct),
    exitKind: r.exit_kind == null ? undefined : String(r.exit_kind),
  };
}
