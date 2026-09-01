/**
 * An unreadable credentials file is a fault, not an empty store.
 *
 * Isolated with MIZAN_DIR_OVERRIDE, set before any import, because `credentials.ts` derives
 * CREDENTIALS_PATH from MIZAN_DIR at module load and this test writes a deliberately corrupt file.
 * `node --test` runs each file in its own process, so the assignment cannot leak into another test.
 * Without the override the only place to write that file is the owner's real `.mizan/`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-creds-'));
process.env.MIZAN_DIR_OVERRIDE = SCRATCH;

// Imported through require rather than a top-level `await import` so the env assignment above
// still runs first under the tests' CommonJS target.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  loadCredentials,
  saveCredentials,
  credentialsUnreadable,
  updateSimplefin,
  updateAiKey,
  _resetCredentialsCacheForTesting,
} = require('../server/src/services/credentials') as typeof import('../server/src/services/credentials');

const CREDS = path.join(SCRATCH, 'credentials.json');

function writeUndecryptable(): void {
  // Well-formed envelope, wrong key material: exactly what a locked keychain or a moved .mizan
  // produces, and it fails GCM auth rather than JSON parsing.
  fs.writeFileSync(
    CREDS,
    JSON.stringify({ iv: '00'.repeat(12), authTag: '11'.repeat(16), ciphertext: '2222' }),
    { mode: 0o600 }
  );
  _resetCredentialsCacheForTesting();
}

function clearFile(): void {
  if (fs.existsSync(CREDS)) fs.unlinkSync(CREDS);
  _resetCredentialsCacheForTesting();
}

test('HEALTHY: no credentials file is an empty store and no fault at all', () => {
  clearFile();
  assert.deepEqual(loadCredentials(), {});
  // The whole point of the distinction: absence must stay silent, or the fault flag is noise.
  assert.equal(credentialsUnreadable(), null);
});

test('HEALTHY: a readable file reports no fault and writes are allowed', () => {
  clearFile();
  saveCredentials({ simplefin: { accessUrl: 'https://example.invalid/x' } });
  _resetCredentialsCacheForTesting();

  assert.deepEqual(loadCredentials(), { simplefin: { accessUrl: 'https://example.invalid/x' } });
  assert.equal(credentialsUnreadable(), null);
});

test('an undecryptable file is a fault, not an empty store', () => {
  writeUndecryptable();

  // Still total: read paths ask only whether a provider is configured, and a throw here would take
  // the app down over a locked keychain.
  assert.deepEqual(loadCredentials(), {});
  assert.ok(credentialsUnreadable(), 'an unreadable file was indistinguishable from no file');
});

test('a write over an unreadable file is refused, so the other keys survive', () => {
  clearFile();
  saveCredentials({
    coinbase: { keyName: 'k', privateKey: 'p' },
    ai: { anthropic: 'sk-real' },
    simplefin: { accessUrl: 'https://example.invalid/old' },
  });
  const intact = fs.readFileSync(CREDS, 'utf8');

  // Now the key stops working. The owner sees "SimpleFIN not connected" and re-links.
  writeUndecryptable();
  const corrupted = fs.readFileSync(CREDS, 'utf8');

  assert.throws(
    () => updateSimplefin('https://example.invalid/new'),
    /Refusing to write/,
    'a re-link silently replaced the whole store with just the SimpleFIN URL'
  );
  assert.throws(() => updateAiKey('anthropic', 'sk-new'), /Refusing to write/);

  // The file is untouched by the refusal: it is still the only copy of the Coinbase and AI keys,
  // and it becomes readable again the moment the keychain is unlocked.
  assert.equal(fs.readFileSync(CREDS, 'utf8'), corrupted);
  assert.notEqual(intact, corrupted);
});

test('the fault clears once the file can be read again', () => {
  writeUndecryptable();
  // The flag is set by an attempted load, not by the file existing, so ask for one first.
  loadCredentials();
  assert.ok(credentialsUnreadable());

  clearFile();
  loadCredentials();
  // A latched fault would refuse writes forever after one bad boot.
  assert.equal(credentialsUnreadable(), null);
  saveCredentials({ ai: { openai: 'sk-ok' } });
  assert.deepEqual(loadCredentials(), { ai: { openai: 'sk-ok' } });
});

test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));
