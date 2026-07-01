import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Entry } from '@napi-rs/keyring';
import { MIZAN_DIR } from '../db/index';

const CREDENTIALS_PATH = path.join(MIZAN_DIR, 'credentials.json');
const KEY_PATH = path.join(MIZAN_DIR, 'mizan.key');

interface EncryptedFile {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface CoinbaseCredentials {
  keyName: string;
  privateKey: string;
}

export interface CredentialsStore {
  coinbase?: CoinbaseCredentials;
  simplefin?: { setupToken?: string; accessUrl?: string };
}

let _key: Buffer | null = null;
let _cache: CredentialsStore | null = null;

function getDerivedKey(): Buffer {
  if (_key) return _key;

  const service = 'mizan';
  const account = 'encryption_key';
  
  let entry: Entry | null = null;
  try {
    entry = new Entry(service, account);
    const hexKey = entry.getPassword();
    if (hexKey && hexKey.length === 64) {
      _key = Buffer.from(hexKey, 'hex');
      return _key;
    }
  } catch (err) {
    // If not found or keychain inaccessible, proceed to fallback/generation
  }

  // Fallback to legacy file if it exists, to migrate gracefully
  if (fs.existsSync(KEY_PATH)) {
    console.log('[credentials] Migrating encryption key to native keychain...');
    _key = fs.readFileSync(KEY_PATH);
    const hexKey = _key.toString('hex');
    
    if (entry) {
      try {
        entry.setPassword(hexKey);
        
        // Verify write before deleting the fallback
        const readBack = entry.getPassword();
        if (readBack === hexKey) {
          fs.unlinkSync(KEY_PATH);
          console.log('[credentials] Migration successful, removed legacy key file.');
        } else {
          console.warn('[credentials] Keychain verification failed. Legacy key file retained.');
        }
        return _key;
      } catch (err) {
        console.error('[credentials] Failed to migrate key to keychain:', (err as Error).message);
        return _key;
      }
    }
    return _key;
  }

  // Generate new key
  _key = crypto.randomBytes(32);
  if (entry) {
    try {
      entry.setPassword(_key.toString('hex'));
    } catch (err) {
      console.error('[credentials] Failed to store key in keychain, falling back to file:', (err as Error).message);
      fs.writeFileSync(KEY_PATH, _key, { mode: 0o600 });
    }
  } else {
    fs.writeFileSync(KEY_PATH, _key, { mode: 0o600 });
  }

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

export function getEnvCredentials(): Partial<CredentialsStore> {
  const result: Partial<CredentialsStore> = {};
  if (process.env.COINBASE_KEY_NAME && process.env.COINBASE_PRIVATE_KEY) {
    result.coinbase = {
      keyName: process.env.COINBASE_KEY_NAME,
      privateKey: process.env.COINBASE_PRIVATE_KEY,
    };
  }
  return result;
}

export function getCredentials(): CredentialsStore {
  const stored = loadCredentials();
  const env = getEnvCredentials();
  return { ...stored, ...env };
}

export function updateCoinbaseCredentials(coinbase: CoinbaseCredentials): void {
  const store = loadCredentials();
  store.coinbase = coinbase;
  saveCredentials(store);
}

export function updateSimplefin(accessUrl: string): void {
  const store = loadCredentials();
  store.simplefin = { ...store.simplefin, accessUrl };
  saveCredentials(store);
}

export function removeSimplefin(): void {
  const store = loadCredentials();
  if (store.simplefin) {
    delete store.simplefin.accessUrl;
    delete store.simplefin.setupToken;
    saveCredentials(store);
  }
}

export function removeCoinbaseCredentials(): void {
  const store = loadCredentials();
  delete store.coinbase;
  saveCredentials(store);
}

