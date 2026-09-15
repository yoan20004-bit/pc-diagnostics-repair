import type { Keypair } from '@solana/web3.js';
import type { BotConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { JupiterClient } from '../market/jupiter.js';
import type { SolanaRpc } from '../rpc.js';
import type { Fill } from '../types.js';
import { LAMPORTS, SOL_MINT, fromRaw, sleep, toRaw } from '../utils.js';

const log = createLogger('exec');

export interface QuotePreview {
  priceImpactPct?: number;
  slippageBps?: number;
  outAmountRaw: bigint;
  route?: string;
  /** expected SOL per raw token unit */
  expectedPriceSol: number;
  /** % lost by immediately selling what the buy returns (sell-path verification) */
  roundTripLossPct?: number;
}

export interface SellPreview {
  expectedSolOut: number;
  priceImpactPct?: number;
}

export interface Executor {
  readonly mode: 'paper' | 'live';
  /** Preview a buy without executing (for risk checks and slippage tracking). Verifies the sell path too. */
  previewBuy(mint: string, solAmount: number): Promise<QuotePreview>;
  /** Expected SOL from selling the given amount right now. */
  previewSell(mint: string, amountRaw: bigint): Promise<SellPreview>;
  buy(mint: string, decimals: number, solAmount: number): Promise<Fill>;
  sell(mint: string, decimals: number, amountRaw: bigint): Promise<Fill>;
  solBalance(): Promise<number>;
  tokenBalance(mint: string): Promise<bigint>;
}

/* ============================================================================
 * LIVE executor: Jupiter Ultra (order -> sign -> execute) with Swap API fallback.
 * ========================================================================== */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;

  constructor(
    private rpc: SolanaRpc,
    private jup: JupiterClient,
    private keypair: Keypair,
    private cfg: BotConfig['execution'],
  ) {}

  private get pubkey() {
    return this.keypair.publicKey.toBase58();
  }

  async solBalance() {
    return this.rpc.getSolBalance(this.keypair.publicKey);
  }

  async tokenBalance(mint: string) {
    return (await this.rpc.getTokenBalance(this.keypair.publicKey, mint)).amountRaw;
  }

  async previewBuy(mint: string, solAmount: number): Promise<QuotePreview> {
    const amount = toRaw(solAmount, 9);
    // quotes (not orders) for both legs: cheap, and the sell leg proves the token can be sold
    const q = await this.jup.swapQuote({ inputMint: SOL_MINT, outputMint: mint, amount, slippageBps: this.cfg.slippageBps });
    const out = BigInt(q.outAmount);
    let roundTripLossPct: number | undefined;
    try {
      const back = await this.jup.swapQuote({ inputMint: mint, outputMint: SOL_MINT, amount: out, slippageBps: this.cfg.slippageBps });
      const solBack = fromRaw(BigInt(back.outAmount), 9);
      roundTripLossPct = ((solAmount - solBack) / solAmount) * 100;
    } catch (e) {
      log.warn(`sell-path quote failed for ${mint}: ${(e as Error).message}`);
      roundTripLossPct = 100; // cannot be sold right now
    }
    return {
      priceImpactPct: num(q.priceImpactPct),
      slippageBps: q.slippageBps,
      outAmountRaw: out,
      route: q.routePlan?.map((r) => r.swapInfo?.label).join('>'),
      expectedPriceSol: out > 0n ? solAmount / Number(out) : 0,
      roundTripLossPct,
    };
  }

  async previewSell(mint: string, amountRaw: bigint): Promise<SellPreview> {
    const q = await this.jup.swapQuote({ inputMint: mint, outputMint: SOL_MINT, amount: amountRaw, slippageBps: this.cfg.slippageBps });
    return { expectedSolOut: fromRaw(BigInt(q.outAmount), 9), priceImpactPct: num(q.priceImpactPct) };
  }

  async buy(mint: string, _decimals: number, solAmount: number): Promise<Fill> {
    const amount = toRaw(solAmount, 9);
    const before = await this.solBalance();
    const tokenBefore = await this.tokenBalance(mint).catch(() => 0n);
    // If a swap call errors AFTER the transaction landed (execute timeout, confirmation timeout), a
    // blind retry or fallback would buy twice. The landed-check reads the token balance first.
    const res = await this.swapWithRetry(SOL_MINT, mint, amount, async () => {
      const now = await this.tokenBalance(mint).catch(() => tokenBefore);
      return now > tokenBefore ? { inputAmountRaw: amount, outputAmountRaw: now - tokenBefore } : undefined;
    });
    const after = await this.solBalance();
    const tokensOut = res.outputAmountRaw;
    const input = fromRaw(res.inputAmountRaw, 9);
    const diff = before - after;
    // balance diff is the truth (includes fees); guard against a stale read that is wildly off
    const spent = diff >= input && diff < input * 1.5 + 0.05 ? diff : input + 0.00001;
    const fee = Math.max(0, spent - input);
    return { ...res, priceSol: tokensOut > 0n ? spent / Number(tokensOut) : 0, feeSol: fee };
  }

  async sell(mint: string, _decimals: number, amountRaw: bigint): Promise<Fill> {
    const before = await this.solBalance();
    const tokenBefore = await this.tokenBalance(mint).catch(() => amountRaw);
    const res = await this.swapWithRetry(mint, SOL_MINT, amountRaw, async () => {
      const now = await this.tokenBalance(mint).catch(() => tokenBefore);
      if (now >= tokenBefore) return undefined;
      const solNow = await this.solBalance();
      return { inputAmountRaw: tokenBefore - now, outputAmountRaw: toRaw(Math.max(0, solNow - before), 9) };
    });
    const after = await this.solBalance();
    const gross = fromRaw(res.outputAmountRaw, 9);
    const diff = after - before; // net of fees
    const received = diff > gross * 0.5 && diff <= gross ? diff : Math.max(0, gross - 0.00001); // guard stale reads
    const fee = Math.max(0, gross - received);
    return { ...res, priceSol: amountRaw > 0n ? received / Number(amountRaw) : 0, feeSol: fee, outputAmountRaw: toRaw(Math.max(received, 0), 9) };
  }

  private async swapWithRetry(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    landed: () => Promise<{ inputAmountRaw: bigint; outputAmountRaw: bigint } | undefined>,
  ) {
    type Res = Omit<Fill, 'priceSol' | 'feeSol'> & { inputAmountRaw: bigint; outputAmountRaw: bigint };
    const orLanded = async (e: unknown): Promise<Res | undefined> => {
      await sleep(2500); // let a just-sent transaction confirm before judging
      const l = await landed();
      if (!l) return undefined;
      log.warn(`swap reported an error (${(e as Error).message}) but the balance moved: treating it as filled, no retry`);
      return { ...l, signature: undefined, route: 'landed-after-error' };
    };
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      try {
        if (this.cfg.engine === 'ultra') {
          try {
            return await this.ultraSwap(inputMint, outputMint, amount);
          } catch (e) {
            const l = await orLanded(e);
            if (l) return l;
            log.warn(`ultra swap failed (${(e as Error).message}); falling back to swap API`);
            return await this.classicSwap(inputMint, outputMint, amount);
          }
        }
        return await this.classicSwap(inputMint, outputMint, amount);
      } catch (e) {
        const l = await orLanded(e);
        if (l) return l;
        lastErr = e;
        log.warn(`swap attempt ${attempt + 1}/${this.cfg.retries + 1} failed: ${(e as Error).message}`);
        await sleep(1500 * (attempt + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async ultraSwap(inputMint: string, outputMint: string, amount: bigint): Promise<Omit<Fill, 'priceSol' | 'feeSol'> & { inputAmountRaw: bigint; outputAmountRaw: bigint }> {
    const order = await this.jup.ultraOrder({ inputMint, outputMint, amount, taker: this.pubkey, slippageBps: this.cfg.ultraSlippageBps });
    const tx = this.rpc.signTransaction(order.transaction as string, this.keypair);
    const signed = Buffer.from(tx.serialize()).toString('base64');
    const res = await this.jup.ultraExecute(signed, order.requestId);
    if (res.status !== 'Success') {
      throw new Error(`Ultra execute ${res.status} code=${res.code ?? '?'}: ${res.error ?? 'unknown error'}`);
    }
    log.info(`ultra swap landed: ${res.signature} (router=${order.router ?? '?'}, slippage=${order.slippageBps}bps)`);
    return {
      signature: res.signature,
      inputAmountRaw: BigInt(res.inputAmountResult ?? order.inAmount),
      outputAmountRaw: BigInt(res.outputAmountResult ?? order.outAmount),
      slippageBps: order.slippageBps,
      priceImpactPct: num(order.priceImpactPct),
      route: order.router,
    };
  }

  private async classicSwap(inputMint: string, outputMint: string, amount: bigint) {
    const quote = await this.jup.swapQuote({ inputMint, outputMint, amount, slippageBps: this.cfg.slippageBps });
    const built = await this.jup.swapBuild({
      quoteResponse: quote,
      userPublicKey: this.pubkey,
      priorityLevel: this.cfg.priorityLevel,
      maxLamports: this.cfg.maxPriorityFeeLamports,
    });
    if (built.simulationError?.error) throw new Error(`swap simulation failed: ${built.simulationError.error}`);
    const tx = this.rpc.signTransaction(built.swapTransaction, this.keypair);
    const signature = await this.rpc.sendAndConfirm(tx, built.lastValidBlockHeight, this.cfg.confirmTimeoutSec * 1000);
    log.info(`swap landed: ${signature} (priority fee ${(built.prioritizationFeeLamports ?? 0) / LAMPORTS} SOL)`);
    // Actual output is unknown without parsing the tx; use quote and let balance diff correct the SOL side.
    return {
      signature,
      inputAmountRaw: BigInt(quote.inAmount),
      outputAmountRaw: BigInt(quote.outAmount),
      slippageBps: quote.slippageBps,
      priceImpactPct: num(quote.priceImpactPct),
      route: quote.routePlan?.map((r) => r.swapInfo?.label).join('>'),
    };
  }
}

/* ============================================================================
 * PAPER executor: simulated fills at the live price with slippage + fee.
 * ========================================================================== */
export interface PaperState {
  solBalance: number;
  tokens: Record<string, string>; // mint -> raw amount
}

export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;
  state: PaperState;

  constructor(
    private priceSol: (mint: string) => number | undefined,
    private cfg: BotConfig['execution'],
    initial?: PaperState,
    private persist?: (s: PaperState) => void,
    startingSol = 5,
  ) {
    this.state = initial ?? { solBalance: startingSol, tokens: {} };
  }

  async solBalance() {
    return this.state.solBalance;
  }

  async tokenBalance(mint: string) {
    return BigInt(this.state.tokens[mint] ?? '0');
  }

  async previewBuy(mint: string, solAmount: number): Promise<QuotePreview> {
    const p = this.requirePrice(mint);
    return { priceImpactPct: 0.1, slippageBps: this.cfg.paperSlippageBps, outAmountRaw: BigInt(Math.floor(solAmount / p)), route: 'paper', expectedPriceSol: p, roundTripLossPct: (this.cfg.paperSlippageBps / 10_000) * 200 };
  }

  async previewSell(mint: string, amountRaw: bigint): Promise<SellPreview> {
    const p = this.requirePrice(mint);
    return { expectedSolOut: Number(amountRaw) * p, priceImpactPct: 0.1 };
  }

  async buy(mint: string, _decimals: number, solAmount: number): Promise<Fill> {
    const p = this.requirePrice(mint);
    const fee = this.cfg.paperFeeSol;
    if (this.state.solBalance < solAmount + fee) throw new Error('paper: insufficient SOL');
    const fillPrice = p * (1 + this.cfg.paperSlippageBps / 10_000);
    const tokensRaw = BigInt(Math.floor(solAmount / fillPrice));
    this.state.solBalance -= solAmount + fee;
    this.state.tokens[mint] = (BigInt(this.state.tokens[mint] ?? '0') + tokensRaw).toString();
    this.persist?.(this.state);
    await sleep(50);
    return { signature: `paper-${Date.now()}`, inputAmountRaw: toRaw(solAmount, 9), outputAmountRaw: tokensRaw, priceSol: fillPrice, feeSol: fee, slippageBps: this.cfg.paperSlippageBps, route: 'paper' };
  }

  async sell(mint: string, _decimals: number, amountRaw: bigint): Promise<Fill> {
    const p = this.requirePrice(mint);
    const held = BigInt(this.state.tokens[mint] ?? '0');
    const amt = amountRaw > held ? held : amountRaw;
    if (amt <= 0n) throw new Error('paper: nothing to sell');
    const fillPrice = p * (1 - this.cfg.paperSlippageBps / 10_000);
    const gross = Number(amt) * fillPrice;
    const fee = this.cfg.paperFeeSol;
    this.state.solBalance += gross - fee;
    this.state.tokens[mint] = (held - amt).toString();
    if (this.state.tokens[mint] === '0') delete this.state.tokens[mint];
    this.persist?.(this.state);
    await sleep(50);
    return { signature: `paper-${Date.now()}`, inputAmountRaw: amt, outputAmountRaw: toRaw(Math.max(gross - fee, 0), 9), priceSol: fillPrice, feeSol: fee, slippageBps: this.cfg.paperSlippageBps, route: 'paper' };
  }

  private requirePrice(mint: string): number {
    const p = this.priceSol(mint);
    if (!p || !Number.isFinite(p) || p <= 0) throw new Error(`paper: no price for ${mint}`);
    return p; // SOL per raw token unit
  }
}

function num(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? Math.abs(n) : undefined;
}
