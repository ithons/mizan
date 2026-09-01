import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'server/src/index.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * What the access log retains, and for how long.
 *
 * `.mizan/logs/server.log` was `morgan('combined')` appended forever: 6,770,252 bytes covering
 * 1 June to 31 August, with the Ledger search box's contents persisted verbatim in every
 * `GET /api/transactions?...&search=<term>` line, and no reset or export path touching it. The
 * owner could not have answered "what does this app write down about what I typed" without
 * reading the file, and the honest answer was "everything, indefinitely".
 */
test('the persisted access log records the path, never the query string', () => {
  assert.doesNotMatch(SRC, /morgan\('combined'/, "'combined' logs the full request line, search terms included");
  assert.match(SRC, /morgan\.token\('path'/, 'no path token is defined');
  const fileFormat = SRC.match(/app\.use\(morgan\('([^']+)', \{ stream: logStream \}\)\)/);
  assert.ok(fileFormat, 'the file-backed morgan line is not where this test expects it');
  assert.match(fileFormat[1], /:method :path HTTP/);
  assert.doesNotMatch(fileFormat[1], /:url/, 'the persisted format still carries the query string');
});

test('the access log is bounded at startup', () => {
  assert.match(SRC, /LOG_ROTATE_BYTES = 8 \* 1024 \* 1024/);
  assert.match(SRC, /fs\.renameSync\(logPath, `\$\{logPath\}\.1`\)/, 'nothing rotates the log');
  // The console copy is the developer's terminal, not a file, and keeps the fuller format.
  assert.match(SRC, /morgan\('dev'\)/);
});

test('the backup description names the advisor tables it contains', () => {
  const src = readFileSync(join(__dirname, '..', 'client/src/views/settings/DataSection.tsx'), 'utf8');
  // `LOCAL_BACKUP_TABLES` carries conversations, messages, ai_memory, advisor_drafts,
  // advisor_actions, ai_runs, ai_feedback and ai_incidents. The sentence beneath "Full Local
  // Backup" listed eight categories and none of them, under a caveat that read as complete.
  const sentence = src.match(/Download or restore [^<]+/)?.[0] ?? '';
  for (const word of ['conversations', 'memory', 'drafts', 'actions']) {
    assert.match(sentence, new RegExp(word), `the backup copy does not say it contains the advisor's ${word}`);
  }
  assert.match(sentence, /Provider credentials are not included/);
});
