import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalGuardConfig, evaluateLocalRequest } from '../server/src/middleware/localGuard';

const config = buildLocalGuardConfig({ port: 3001, host: '127.0.0.1', hostIsLoopback: true });

test('allows a same-origin GET from localhost', () => {
  const v = evaluateLocalRequest({ host: 'localhost:3001', method: 'GET' }, config);
  assert.equal(v.allowed, true);
});

test('allows a same-origin POST from 127.0.0.1 with matching Origin', () => {
  const v = evaluateLocalRequest(
    { host: '127.0.0.1:3001', method: 'POST', origin: 'http://127.0.0.1:3001' },
    config
  );
  assert.equal(v.allowed, true);
});

test('rejects a foreign Host header (DNS rebinding)', () => {
  const v = evaluateLocalRequest({ host: 'evil.example.com', method: 'GET' }, config);
  assert.equal(v.allowed, false);
  assert.match(v.reason ?? '', /Host/);
});

test('rejects a state-changing request with a foreign Origin', () => {
  const v = evaluateLocalRequest(
    { host: 'localhost:3001', method: 'POST', origin: 'https://evil.example.com' },
    config
  );
  assert.equal(v.allowed, false);
  assert.match(v.reason ?? '', /cross-origin/);
});

test('does not require an Origin on GET (SSE streams omit it)', () => {
  const v = evaluateLocalRequest({ host: 'localhost:3001', method: 'GET' }, config);
  assert.equal(v.allowed, true);
});

test('allows a POST with no Origin header (curl / non-browser clients)', () => {
  const v = evaluateLocalRequest({ host: '127.0.0.1:3001', method: 'POST' }, config);
  assert.equal(v.allowed, true);
});

test('honors CORS_ORIGIN hosts when deliberately exposed', () => {
  const exposed = buildLocalGuardConfig({
    port: 3001,
    host: '0.0.0.0',
    hostIsLoopback: false,
    corsOrigin: 'https://mizan.example.com',
  });
  const v = evaluateLocalRequest(
    { host: 'mizan.example.com', method: 'POST', origin: 'https://mizan.example.com' },
    exposed
  );
  assert.equal(v.allowed, true);
});
