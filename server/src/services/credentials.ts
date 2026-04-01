import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { machineIdSync } from 'node-machine-id';
import { MIZAN_DIR } from '../db/index';

const CREDENTIALS_PATH = path.join(MIZAN_DIR, 'credentials.json');
const SALT = 'mizan-v1';

interface EncryptedFile {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface PlaidCredentials {
  clientId: string;
  secret: string;
  environment: 'sandbox' | 'production';
}

export interface CoinbaseCredentials {
  keyName: string;
  privateKey: string;
}

export interface CredentialsStore {
  plaid?: PlaidCredentials;
  coinbase?: CoinbaseCredentials;
  plaidItems?: Record<string, { accessToken: string }>;
}

let _key: Buffer | null = null;
let _cache: CredentialsStore | null = null;

function getDerivedKey(): Buffer {
  if (_key) return _key;
  const machineId = machineIdSync(true);
  _key = crypto.scryptSync(machineId, SALT, 32, { N: 16384 });
  return _key;
}

function encrypt(plaintext: string): EncryptedFile {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

function decrypt(enc: EncryptedFile): string {
  const key = getDerivedKey();
  const iv = Buffer.from(enc.iv, 'hex');
  const authTag = Buffer.from(enc.authTag, 'hex');
  const ciphertext = Buffer.from(enc.ciphertext, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

export function loadCredentials(): CredentialsStore {
  if (_cache) return _cache;
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    _cache = {};
    return _cache;
  }
  try {
    const enc: EncryptedFile = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    _cache = JSON.parse(decrypt(enc)) as CredentialsStore;
    return _cache;
  } catch (err) {
    console.error('[credentials] Failed to decrypt credentials:', (err as Error).message);
    _cache = {};
    return _cache;
  }
}

export function saveCredentials(store: CredentialsStore): void {
  _cache = store;
  const enc = encrypt(JSON.stringify(store));
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(enc), { mode: 0o600 });
}

export function getCredentials(): CredentialsStore {
  return loadCredentials();
}

export function updatePlaidCredentials(plaid: PlaidCredentials): void {
  const store = loadCredentials();
  store.plaid = plaid;
  saveCredentials(store);
}

export function updateCoinbaseCredentials(coinbase: CoinbaseCredentials): void {
  const store = loadCredentials();
  store.coinbase = coinbase;
  saveCredentials(store);
}

export function savePlaidItemToken(itemId: string, accessToken: string): void {
  const store = loadCredentials();
  if (!store.plaidItems) store.plaidItems = {};
  store.plaidItems[itemId] = { accessToken };
  saveCredentials(store);
}

export function removePlaidItemToken(itemId: string): void {
  const store = loadCredentials();
  if (store.plaidItems) {
    delete store.plaidItems[itemId];
    saveCredentials(store);
  }
}

export function removeCoinbaseCredentials(): void {
  const store = loadCredentials();
  delete store.coinbase;
  saveCredentials(store);
}
