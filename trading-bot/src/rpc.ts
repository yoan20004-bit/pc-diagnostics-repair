import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  type Commitment,
  type ParsedAccountData,
} from '@solana/web3.js';
import { createLogger } from './logger.js';
import { LAMPORTS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, sleep } from './utils.js';

const log = createLogger('rpc');

export interface MintInfo {
  mint: string;
  decimals: number;
  supplyRaw: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  program: 'token' | 'token2022' | 'unknown';
  extensions?: string[];
}

export interface TokenBalance {
  amountRaw: bigint;
  uiAmount: number;
  decimals: number;
}

export type PriorityLevel = 'medium' | 'high' | 'veryHigh';

export class SolanaRpc {
  readonly connection: Connection;
  private isHelius: boolean;

  constructor(readonly rpcUrl: string, wsUrl?: string, commitment: Commitment = 'confirmed') {
    this.connection = new Connection(rpcUrl, { commitment, wsEndpoint: wsUrl, disableRetryOnRateLimit: false });
    this.isHelius = /helius/i.test(rpcUrl);
  }

  async getSolBalance(pubkey: PublicKey): Promise<number> {
    return (await this.connection.getBalance(pubkey, 'confirmed')) / LAMPORTS;
  }

  async getTokenBalance(owner: PublicKey, mint: string): Promise<TokenBalance> {
    const mintPk = new PublicKey(mint);
    const accounts = await this.connection.getParsedTokenAccountsByOwner(owner, { mint: mintPk }, 'confirmed');
    let amountRaw = 0n;
    let decimals = 0;
    for (const acc of accounts.value) {
      const info = (acc.account.data as ParsedAccountData).parsed?.info;
      const ta = info?.tokenAmount;
      if (!ta) continue;
      amountRaw += BigInt(ta.amount);
      decimals = Number(ta.decimals);
    }
    return { amountRaw, decimals, uiAmount: Number(amountRaw) / 10 ** decimals };
  }

  async getMintInfo(mint: string): Promise<MintInfo> {
    const res = await this.connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const acc = res.value;
    if (!acc) throw new Error(`Mint ${mint} not found`);
    const owner = acc.owner.toBase58();
    const program = owner === TOKEN_PROGRAM_ID ? 'token' : owner === TOKEN_2022_PROGRAM_ID ? 'token2022' : 'unknown';
    const data = acc.data as ParsedAccountData;
    const info = data.parsed?.info ?? {};
    const extensions: string[] | undefined = Array.isArray(info.extensions)
      ? info.extensions.map((e: { extension?: string }) => e.extension ?? 'unknown')
      : undefined;
    return {
      mint,
      decimals: Number(info.decimals ?? 0),
      supplyRaw: BigInt(info.supply ?? 0),
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      program,
      extensions,
    };
  }

  /** Returns the share (%) of supply held by the top N largest token accounts. */
  async getTopHolderShare(mint: string, supplyRaw: bigint, topN = 10): Promise<{ topPct: number; largestPct: number }> {
    if (supplyRaw === 0n) return { topPct: 0, largestPct: 0 };
    const res = await this.connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
    const amounts = res.value.slice(0, topN).map((a) => BigInt(a.amount));
    const sum = amounts.reduce((a, b) => a + b, 0n);
    const largest = amounts[0] ?? 0n;
    return {
      topPct: Number((sum * 10000n) / supplyRaw) / 100,
      largestPct: Number((largest * 10000n) / supplyRaw) / 100,
    };
  }

  /** Priority fee estimate in micro-lamports per compute unit. */
  async getPriorityFeeMicroLamports(level: PriorityLevel, accountKeys: string[] = []): Promise<number> {
    if (this.isHelius) {
      try {
        const body = {
          jsonrpc: '2.0',
          id: 1,
          method: 'getPriorityFeeEstimate',
          params: [{ accountKeys, options: { priorityLevel: level === 'veryHigh' ? 'VeryHigh' : level === 'high' ? 'High' : 'Medium' } }],
        };
        const res = await fetch(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const json = (await res.json()) as { result?: { priorityFeeEstimate?: number } };
        if (json.result?.priorityFeeEstimate) return Math.ceil(json.result.priorityFeeEstimate);
      } catch (e) {
        log.debug('helius fee estimate failed, falling back', e);
      }
    }
    const fees = await this.connection.getRecentPrioritizationFees({
      lockedWritableAccounts: accountKeys.slice(0, 5).map((k) => new PublicKey(k)),
    });
    const values = fees.map((f) => f.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
    if (!values.length) return level === 'veryHigh' ? 200_000 : level === 'high' ? 100_000 : 20_000;
    const q = level === 'veryHigh' ? 0.95 : level === 'high' ? 0.8 : 0.5;
    return Math.max(1000, values[Math.min(values.length - 1, Math.floor(values.length * q))]);
  }

  signTransaction(base64Tx: string, signer: Keypair): VersionedTransaction {
    const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, 'base64'));
    tx.sign([signer]);
    return tx;
  }

  /** Sends a signed transaction and polls for confirmation (no websockets required). */
  async sendAndConfirm(tx: VersionedTransaction, lastValidBlockHeight: number, timeoutMs = 75_000): Promise<string> {
    const raw = tx.serialize();
    const signature = await this.connection.sendRawTransaction(raw, {
      skipPreflight: true,
      maxRetries: 0,
      preflightCommitment: 'confirmed',
    });
    const started = Date.now();
    let lastSend = started;
    for (;;) {
      const st = await this.connection.getSignatureStatuses([signature]);
      const s = st.value[0];
      if (s) {
        if (s.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(s.err)}`);
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return signature;
      }
      const height = await this.connection.getBlockHeight('confirmed');
      if (height > lastValidBlockHeight) throw new Error(`Transaction ${signature} expired (blockhash too old)`);
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${signature}`);
      // re-broadcast every 2s until it lands (standard practice for tx landing)
      if (Date.now() - lastSend > 2000) {
        lastSend = Date.now();
        await this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
      }
      await sleep(1000);
    }
  }
}
