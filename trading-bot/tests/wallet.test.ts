import { describe, expect, it } from 'vitest';
import { generateWallet, loadKeypair } from '../src/wallet.js';

describe('wallet', () => {
  it('round-trips base58 (Phantom format) and JSON array formats', () => {
    const w = generateWallet();
    const fromB58 = loadKeypair(w.base58);
    const fromJson = loadKeypair(w.jsonArray);
    expect(fromB58.publicKey.toBase58()).toBe(w.keypair.publicKey.toBase58());
    expect(fromJson.publicKey.toBase58()).toBe(w.keypair.publicKey.toBase58());
  });

  it('rejects garbage', () => {
    expect(() => loadKeypair('not-a-key!!')).toThrow();
    expect(() => loadKeypair('')).toThrow();
  });
});
