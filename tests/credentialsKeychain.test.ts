/**
 * The keychain key is the only thing that can decrypt credentials.json, and it does not travel.
 * Every way the keychain can fail to hand it over must refuse, never replace it with a fresh key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Entry } from '@napi-rs/keyring';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-keychain-'));
process.env.MIZAN_DIR_OVERRIDE = SCRATCH;

const CREDS = path.join(SCRATCH, 'credentials.json');
const KEY_FILE = path.join(SCRATCH, 'mizan.key');
const originalGet = Entry.prototype.getPassword;
const originalSet = Entry.prototype.setPassword;

type CredentialsModule = typeof import('../server/src/services/credentials');

interface Keychain {
  setCalls: string[];
}

function stubKeychain(read: () => string | null): Keychain {
  const keychain: Keychain = { setCalls: [] };
  Entry.prototype.getPassword = read;
  Entry.prototype.setPassword = function (pass: string) {
    keychain.setCalls.push(pass);
  };
  return keychain;
}

async function freshModule(): Promise<CredentialsModule> {
  return (await import(
    `../server/src/services/credentials.ts?bust=${crypto.randomUUID()}`
  )) as CredentialsModule;
}

/** A credentials file encrypted under some key the stubbed keychain will not produce. */
function writeExistingCredentials(): string {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update('{"ai":{"anthropic":"sk-real"}}'), cipher.final()]);
  const body = JSON.stringify({
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  });
  fs.writeFileSync(CREDS, body, { mode: 0o600 });
  return key.toString('hex');
}

test.afterEach(() => {
  Entry.prototype.getPassword = originalGet;
  Entry.prototype.setPassword = originalSet;
  fs.rmSync(CREDS, { force: true });
  fs.rmSync(KEY_FILE, { force: true });
});

test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const REFUSALS: Array<[string, () => string | null]> = [
  [
    'the keychain read throws (locked, or access denied after a Node change)',
    () => {
      throw new Error('User interaction is not allowed.');
    },
  ],
  ['the keychain entry is not a 64-character hex key', () => 'not-a-key'],
  ['the keychain has no entry while credentials.json exists', () => null],
];

for (const [scenario, read] of REFUSALS) {
  test(`${scenario}: refuses, never replaces the key, and keeps writes refused`, async () => {
    writeExistingCredentials();
    const before = fs.readFileSync(CREDS, 'utf8');
    const keychain = stubKeychain(read);
    const creds = await freshModule();

    assert.deepEqual(creds.loadCredentials(), {});
    assert.ok(creds.credentialsUnreadable(), 'the fault was not recorded');
    assert.throws(() => creds.updateAiKey('openai', 'sk-new'), /Refusing to write/);

    assert.deepEqual(keychain.setCalls, [], 'a generated key was written over the keychain entry');
    assert.equal(fs.existsSync(KEY_FILE), false, 'a generated key was written to mizan.key');
    assert.equal(fs.readFileSync(CREDS, 'utf8'), before);
  });
}

test('with no credentials file, a throwing keychain still refuses rather than generating', async () => {
  const keychain = stubKeychain(() => {
    throw new Error('User interaction is not allowed.');
  });
  const creds = await freshModule();

  assert.throws(() => creds.saveCredentials({ ai: { openai: 'sk' } }), /keychain/);
  assert.deepEqual(keychain.setCalls, []);
  assert.equal(fs.existsSync(KEY_FILE), false);
  assert.equal(fs.existsSync(CREDS), false);
});

test('HEALTHY: the stored keychain key decrypts the file and nothing is written to the keychain', async () => {
  const hexKey = writeExistingCredentials();
  const keychain = stubKeychain(() => hexKey);
  const creds = await freshModule();

  assert.deepEqual(creds.loadCredentials(), { ai: { anthropic: 'sk-real' } });
  assert.equal(creds.credentialsUnreadable(), null);
  assert.deepEqual(keychain.setCalls, []);
});

test('HEALTHY: a first run with nothing stored generates one key and stores it once', async () => {
  let stored: string | null = null;
  const keychain = stubKeychain(() => stored);
  const creds = await freshModule();

  creds.saveCredentials({ ai: { openai: 'sk-first' } });
  assert.equal(keychain.setCalls.length, 1);
  assert.match(keychain.setCalls[0], /^[0-9a-f]{64}$/);
  stored = keychain.setCalls[0];

  const reloaded = await freshModule();
  assert.deepEqual(reloaded.loadCredentials(), { ai: { openai: 'sk-first' } });
  assert.equal(reloaded.credentialsUnreadable(), null);
  assert.equal(keychain.setCalls.length, 1);
});
