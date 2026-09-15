import { describe, expect, it } from 'vitest';
import { PaperExecutor } from '../src/trading/executor.js';
import { cfg } from './helpers.js';

describe('PaperExecutor', () => {
  it('simulates buys and sells with slippage and fees', async () => {
    const ex = cfg({ execution: { paperSlippageBps: 100, paperFeeSol: 0.001 } }).execution;
    const price = { v: 0.000001 }; // SOL per raw unit
    const saved: unknown[] = [];
    const pe = new PaperExecutor(() => price.v, ex, undefined, (s) => saved.push(s), 2);
    const buy = await pe.buy('m', 6, 1);
    expect(buy.priceSol).toBeCloseTo(0.00000101);
    expect(await pe.solBalance()).toBeCloseTo(2 - 1 - 0.001);
    expect(await pe.tokenBalance('m')).toBe(buy.outputAmountRaw);
    price.v = 0.0000012; // +20%
    const sell = await pe.sell('m', 6, buy.outputAmountRaw);
    expect(await pe.tokenBalance('m')).toBe(0n);
    const bal = await pe.solBalance();
    expect(bal).toBeGreaterThan(2.1);
    expect(sell.feeSol).toBe(0.001);
    expect(saved.length).toBe(2);
  });

  it('refuses to trade without a price or balance', async () => {
    const pe = new PaperExecutor(() => undefined, cfg().execution, undefined, undefined, 1);
    await expect(pe.buy('m', 6, 0.5)).rejects.toThrow(/no price/);
    const pe2 = new PaperExecutor(() => 1, cfg().execution, undefined, undefined, 0.1);
    await expect(pe2.buy('m', 6, 0.5)).rejects.toThrow(/insufficient/);
  });
});
