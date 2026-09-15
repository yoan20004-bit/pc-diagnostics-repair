import { EventEmitter } from 'node:events';
import { PublicKey, type Connection, type AccountInfo } from '@solana/web3.js';
import { createLogger } from '../logger.js';
import type { PairInfo } from '../types.js';

const log = createLogger('stream');

// Raydium AMM v4 pool state: baseVault / quoteVault pubkeys sit after 32 u64 + 4 u128 + 2 u64 fields.
const RAYDIUM_V4_BASE_VAULT_OFFSET = 336;
const RAYDIUM_V4_QUOTE_VAULT_OFFSET = 368;
const RAYDIUM_V4_MIN_LEN = 752;

export interface VaultPair {
  baseVault: string;
  quoteVault: string;
  baseDecimals: number;
  quoteDecimals: number;
  quoteMint: string;
}

export interface StreamTick {
  mint: string;
  /** price in units of the pool's quote token (SOL or USDC) */
  priceQuote: number;
  quoteMint: string;
  ts: number;
}

/** u64 little-endian amount at offset 64 of an SPL token account. */
export function parseTokenAccountAmount(data: Buffer | Uint8Array): bigint {
  if (data.length < 72) throw new Error('not a token account');
  return Buffer.from(data).readBigUInt64LE(64);
}

/** Vault addresses from a Raydium v4 pool account, if the buffer looks like one. */
export function parseRaydiumV4Vaults(data: Buffer | Uint8Array): { baseVault: string; quoteVault: string } | undefined {
  if (data.length < RAYDIUM_V4_MIN_LEN) return undefined;
  const b = Buffer.from(data);
  return {
    baseVault: new PublicKey(b.subarray(RAYDIUM_V4_BASE_VAULT_OFFSET, RAYDIUM_V4_BASE_VAULT_OFFSET + 32)).toBase58(),
    quoteVault: new PublicKey(b.subarray(RAYDIUM_V4_QUOTE_VAULT_OFFSET, RAYDIUM_V4_QUOTE_VAULT_OFFSET + 32)).toBase58(),
  };
}

export function priceFromVaults(baseRaw: bigint, quoteRaw: bigint, baseDecimals: number, quoteDecimals: number): number | undefined {
  if (baseRaw <= 0n || quoteRaw <= 0n) return undefined;
  const base = Number(baseRaw) / 10 ** baseDecimals;
  const quote = Number(quoteRaw) / 10 ** quoteDecimals;
  return base > 0 ? quote / base : undefined;
}

/**
 * Sub-second prices by subscribing to a pool's two token vaults over the RPC WebSocket.
 * Works for pools whose vaults are owned by the pool address (PumpSwap, Orca, Meteora) and
 * for Raydium v4 (decoded from the pool state). Everything else stays on polling.
 */
export class PriceStream extends EventEmitter {
  private subs = new Map<string, { ids: number[]; vaults: VaultPair; base?: bigint; quote?: bigint }>();

  constructor(private conn: Connection, private maxSubscriptions = 25) {
    super();
  }

  get watching(): string[] {
    return [...this.subs.keys()];
  }

  has(mint: string) {
    return this.subs.has(mint);
  }

  async resolveVaults(pair: PairInfo, baseDecimals: number, quoteDecimals: number): Promise<VaultPair | undefined> {
    const mint = pair.baseToken.address;
    const quoteMint = pair.quoteToken.address;
    const pool = new PublicKey(pair.pairAddress);
    // 1. vaults owned by the pool itself
    const [b, q] = await Promise.all([
      this.conn.getTokenAccountsByOwner(pool, { mint: new PublicKey(mint) }, 'confirmed').catch(() => ({ value: [] })),
      this.conn.getTokenAccountsByOwner(pool, { mint: new PublicKey(quoteMint) }, 'confirmed').catch(() => ({ value: [] })),
    ]);
    if (b.value[0] && q.value[0]) {
      return { baseVault: b.value[0].pubkey.toBase58(), quoteVault: q.value[0].pubkey.toBase58(), baseDecimals, quoteDecimals, quoteMint };
    }
    // 2. Raydium v4 layout
    const acc = await this.conn.getAccountInfo(pool, 'confirmed').catch(() => null);
    if (acc?.data) {
      const v = parseRaydiumV4Vaults(acc.data);
      if (v) {
        // verify both vaults are token accounts of the expected mints
        const [va, vb] = await this.conn.getMultipleAccountsInfo([new PublicKey(v.baseVault), new PublicKey(v.quoteVault)], 'confirmed');
        if (va?.data.length === 165 && vb?.data.length === 165) {
          const mintOf = (d: Buffer) => new PublicKey(d.subarray(0, 32)).toBase58();
          const ma = mintOf(va.data);
          const mb = mintOf(vb.data);
          if (ma === mint && mb === quoteMint) return { ...v, baseDecimals, quoteDecimals, quoteMint };
          if (ma === quoteMint && mb === mint) return { baseVault: v.quoteVault, quoteVault: v.baseVault, baseDecimals, quoteDecimals, quoteMint };
        }
      }
    }
    return undefined;
  }

  async watch(mint: string, pair: PairInfo, baseDecimals: number, quoteDecimals: number): Promise<boolean> {
    if (this.subs.has(mint)) return true;
    if (this.subs.size >= this.maxSubscriptions) return false;
    const vaults = await this.resolveVaults(pair, baseDecimals, quoteDecimals);
    if (!vaults) {
      log.debug(`no streamable vaults for ${pair.baseToken.symbol} on ${pair.dexId}`);
      return false;
    }
    const entry = { ids: [] as number[], vaults, base: undefined as bigint | undefined, quote: undefined as bigint | undefined };
    const onChange = (side: 'base' | 'quote') => (info: AccountInfo<Buffer>) => {
      try {
        entry[side] = parseTokenAccountAmount(info.data);
      } catch {
        return;
      }
      const price = priceFromVaults(entry.base ?? 0n, entry.quote ?? 0n, vaults.baseDecimals, vaults.quoteDecimals);
      if (price) this.emit('price', { mint, priceQuote: price, quoteMint: vaults.quoteMint, ts: Date.now() } satisfies StreamTick);
    };
    entry.ids.push(this.conn.onAccountChange(new PublicKey(vaults.baseVault), onChange('base'), 'processed'));
    entry.ids.push(this.conn.onAccountChange(new PublicKey(vaults.quoteVault), onChange('quote'), 'processed'));
    this.subs.set(mint, entry);
    // prime with current balances so the first tick does not wait for a trade
    try {
      const [a, b] = await this.conn.getMultipleAccountsInfo([new PublicKey(vaults.baseVault), new PublicKey(vaults.quoteVault)], 'processed');
      if (a?.data && b?.data) {
        entry.base = parseTokenAccountAmount(a.data);
        entry.quote = parseTokenAccountAmount(b.data);
      }
    } catch {
      /* first trade will prime it */
    }
    log.info(`streaming ${pair.baseToken.symbol} from ${pair.dexId} vaults`);
    return true;
  }

  async unwatch(mint: string) {
    const e = this.subs.get(mint);
    if (!e) return;
    this.subs.delete(mint);
    for (const id of e.ids) await this.conn.removeAccountChangeListener(id).catch(() => undefined);
  }

  async close() {
    for (const m of [...this.subs.keys()]) await this.unwatch(m);
  }
}
