import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

/**
 * Loads a Solana keypair from:
 *  - a base58 secret key string (what Phantom shows under "Show Private Key")
 *  - a JSON byte array (solana-keygen / Solana CLI format)
 *  - a path to a JSON keypair file
 */
export function loadKeypair(secret: string): Keypair {
  const s = secret.trim();
  if (!s) throw new Error('PRIVATE_KEY is empty');

  if (s.startsWith('[')) {
    return fromBytes(Uint8Array.from(JSON.parse(s) as number[]));
  }
  if (s.endsWith('.json')) {
    return fromBytes(Uint8Array.from(JSON.parse(readFileSync(s, 'utf8')) as number[]));
  }
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(s);
  } catch {
    throw new Error('PRIVATE_KEY is not valid base58 (Phantom export) or a JSON byte array');
  }
  return fromBytes(bytes);
}

function fromBytes(bytes: Uint8Array): Keypair {
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Unexpected secret key length ${bytes.length}; expected 64 (or 32-byte seed)`);
}

export function generateWallet(): { keypair: Keypair; base58: string; jsonArray: string } {
  const keypair = Keypair.generate();
  return {
    keypair,
    base58: bs58.encode(keypair.secretKey),
    jsonArray: JSON.stringify(Array.from(keypair.secretKey)),
  };
}

export function keypairToBase58(kp: Keypair): string {
  return bs58.encode(kp.secretKey);
}
