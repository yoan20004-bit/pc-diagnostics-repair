import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
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

/* ---------------------------------------------------------------- encrypted key file */

export interface EncryptedKey {
  v: 1;
  kdf: 'scrypt';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Encrypt a base58 secret key with a password (scrypt + AES-256-GCM). */
export function encryptSecret(secretBase58: string, password: string): EncryptedKey {
  if (!password || password.length < 8) throw new Error('password must be at least 8 characters');
  loadKeypair(secretBase58); // validates
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  const data = Buffer.concat([cipher.update(secretBase58, 'utf8'), cipher.final()]);
  return { v: 1, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptSecret(enc: EncryptedKey, password: string): string {
  if (enc.v !== 1 || enc.kdf !== 'scrypt') throw new Error('unsupported key file format');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, Buffer.from(enc.salt, 'base64')), Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('wrong password or corrupted key file');
  }
}
