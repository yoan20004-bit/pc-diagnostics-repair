import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { LiveExecutor } from '../src/trading/executor.js';
import { cfg } from './helpers.js';

vi.mock('../src/utils.js', async (orig) => ({ ...(await orig<typeof import('../src/utils.js')>()), sleep: async () => undefined }));

/** A transaction that lands but whose execute call errors must NOT be retried or re-sent. */
describe('LiveExecutor landed-after-error protection', () => {
  const kp = Keypair.generate();
  const MINT = Keypair.generate().publicKey.toBase58();

  it('buy: recognises a landed swap and does not fall back to a second swap', async () => {
    let sol = 5;
    let tokens = 0n;
    const rpc = {
      getSolBalance: async () => sol,
      getTokenBalance: async () => ({ amountRaw: tokens, uiAmount: 0, decimals: 6 }),
      signTransaction: () => ({ serialize: () => Buffer.from('x') }),
    } as never;
    const jup = {
      ultraOrder: async () => ({ requestId: 'r', transaction: 'AA==', inAmount: '100000000', outAmount: '5000000', slippageBps: 50 }),
      ultraExecute: async () => {
        sol -= 0.1005; // the trade actually landed...
        tokens = 5_000_000n;
        throw new Error('execute timeout'); // ...but the API call errored
      },
      swapQuote: vi.fn(async () => { throw new Error('should not be called'); }),
    } as never;
    const ex = new LiveExecutor(rpc, jup, kp, cfg().execution);
    const fill = await ex.buy(MINT, 6, 0.1);
    expect(fill.outputAmountRaw).toBe(5_000_000n);
    expect(fill.route).toBe('landed-after-error');
    expect(fill.priceSol).toBeCloseTo(0.1005 / 5_000_000, 12);
    expect((jup as { swapQuote: ReturnType<typeof vi.fn> }).swapQuote).not.toHaveBeenCalled();
  });

  it('buy: falls back when nothing landed', async () => {
    const rpc = { getSolBalance: async () => 5, getTokenBalance: async () => ({ amountRaw: 0n, uiAmount: 0, decimals: 6 }), signTransaction: () => ({ serialize: () => Buffer.from('x') }), sendAndConfirm: async () => 'sig' } as never;
    const swapQuote = vi.fn(async () => ({ inAmount: '100000000', outAmount: '4000000', slippageBps: 100, priceImpactPct: '0.1', routePlan: [] }));
    const jup = { ultraOrder: async () => { throw new Error('ultra down'); }, swapQuote, swapBuild: async () => ({ swapTransaction: 'AA==', lastValidBlockHeight: 1 }) } as never;
    const ex = new LiveExecutor(rpc, jup, kp, cfg().execution);
    const fill = await ex.buy(MINT, 6, 0.1);
    expect(swapQuote).toHaveBeenCalled();
    expect(fill.signature).toBe('sig');
    expect(fill.outputAmountRaw).toBe(4_000_000n);
  });

  it('sell: recognises a landed sell from the token balance drop', async () => {
    let sol = 5;
    let tokens = 1_000_000n;
    const rpc = { getSolBalance: async () => sol, getTokenBalance: async () => ({ amountRaw: tokens, uiAmount: 0, decimals: 6 }), signTransaction: () => ({ serialize: () => Buffer.from('x') }) } as never;
    const jup = {
      ultraOrder: async () => ({ requestId: 'r', transaction: 'AA==', inAmount: '1000000', outAmount: '200000000', slippageBps: 50 }),
      ultraExecute: async () => { tokens = 0n; sol += 0.199; throw new Error('timeout'); },
      swapQuote: vi.fn(async () => { throw new Error('should not be called'); }),
    } as never;
    const ex = new LiveExecutor(rpc, jup, kp, cfg().execution);
    const fill = await ex.sell(MINT, 6, 1_000_000n);
    expect(fill.inputAmountRaw).toBe(1_000_000n);
    expect(Number(fill.outputAmountRaw) / 1e9).toBeCloseTo(0.199, 6);
    expect((jup as { swapQuote: ReturnType<typeof vi.fn> }).swapQuote).not.toHaveBeenCalled();
  });
});
