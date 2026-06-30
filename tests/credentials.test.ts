import test, { mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import { MIZAN_DIR } from '../server/src/db/index.js';

// We import after mocking or inside the test, but since it's a singleton pattern inside credentials,
// we might need to reset its state or mock before import.
// Actually, `getDerivedKey` caches `_key`. So we'll have to reset `_key`.

test('Credentials migration logic with verify-then-delete', async (t) => {
  // Save original methods
  const originalGetPassword = Entry.prototype.getPassword;
  const originalSetPassword = Entry.prototype.setPassword;

  const keyPath = path.join(MIZAN_DIR, 'mizan.key');
  
  t.afterEach(() => {
    // Restore mocks
    Entry.prototype.getPassword = originalGetPassword;
    Entry.prototype.setPassword = originalSetPassword;
    // Clean up
    if (fs.existsSync(keyPath)) {
      fs.unlinkSync(keyPath);
    }
  });

  await t.test('Retains legacy file if read-back verification fails', async () => {
    // Setup legacy file
    if (!fs.existsSync(MIZAN_DIR)) fs.mkdirSync(MIZAN_DIR, { recursive: true });
    const dummyKey = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, dummyKey, { mode: 0o600 });

    // Mock Entry to simulate a broken keychain that accepts writes but returns wrong data
    let storedPass: string | null = null;
    Entry.prototype.setPassword = function (pass: string) { storedPass = pass; };
    Entry.prototype.getPassword = function () { return "wrong_data_read_back"; };

    // Dynamic import to avoid caching issues if we can, but we'll use a hack to reset module cache or just rely on it
    // Because Node ESM doesn't easily reset module cache, we'll append a query string
    const { getCredentials } = await import(`../server/src/services/credentials.ts?cacheBust=${Date.now()}`);

    // Call
    const creds = getCredentials();
    
    // Assert file still exists because verify failed
    assert.ok(fs.existsSync(keyPath), 'Legacy key file should NOT be deleted if verification fails');
  });

  await t.test('Deletes legacy file if read-back verification succeeds', async () => {
    // Setup legacy file
    if (!fs.existsSync(MIZAN_DIR)) fs.mkdirSync(MIZAN_DIR, { recursive: true });
    const dummyKey = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, dummyKey, { mode: 0o600 });

    // Mock Entry to simulate working keychain
    let storedPass: string | null = null;
    Entry.prototype.setPassword = function (pass: string) { storedPass = pass; };
    Entry.prototype.getPassword = function () { return storedPass; };

    const { getCredentials } = await import(`../server/src/services/credentials.ts?cacheBust=${Date.now()}`);

    // Call
    const creds = getCredentials();
    
    // Assert file is deleted because verify succeeded
    assert.ok(!fs.existsSync(keyPath), 'Legacy key file SHOULD be deleted if verification succeeds');
  });
});
