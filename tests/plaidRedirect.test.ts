import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlaidRedirectUri } from '../server/src/services/plaidRedirect';

test('plaid redirect normalization accepts HTTPS origins', () => {
  assert.equal(
    normalizePlaidRedirectUri('https://mizan.example.com/'),
    'https://mizan.example.com'
  );
});

test('plaid redirect normalization rejects HTTP localhost', () => {
  assert.equal(normalizePlaidRedirectUri('http://localhost:5173'), null);
});

test('plaid redirect normalization rejects HTTP 127 localhost', () => {
  assert.equal(normalizePlaidRedirectUri('http://127.0.0.1:5173'), null);
});

test('plaid redirect normalization normalizes HTTPS 127 localhost', () => {
  assert.equal(
    normalizePlaidRedirectUri('https://127.0.0.1:5173'),
    'https://localhost:5173'
  );
});

test('plaid redirect normalization prefers configured HTTPS override', () => {
  assert.equal(
    normalizePlaidRedirectUri('http://localhost:5173', 'https://public-tunnel.example.com/oauth'),
    'https://public-tunnel.example.com/oauth'
  );
});

test('plaid redirect normalization rejects invalid input', () => {
  assert.equal(normalizePlaidRedirectUri('not a uri'), null);
});
