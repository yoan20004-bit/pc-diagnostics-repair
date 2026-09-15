import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateWallet } from '../src/wallet.js';

describe('encrypted key file', () => {
  it('round-trips and rejects wrong passwords', () => {
    const w = generateWallet();
    const enc = encryptSecret(w.base58, 'correct horse battery');
    expect(enc.data).not.toContain(w.base58.slice(0, 10));
    expect(decryptSecret(enc, 'correct horse battery')).toBe(w.base58);
    expect(() => decryptSecret(enc, 'wrong password!')).toThrow(/wrong password/);
    expect(() => encryptSecret(w.base58, 'short')).toThrow(/8 characters/);
    expect(() => encryptSecret('garbage', 'long enough password')).toThrow();
  });
});
