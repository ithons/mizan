/**
 * The Delete All Data copy is the only description of a factory reset the owner reads before
 * typing "delete". It used to list six kinds of data while the route cleared every table but one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FACTORY_RESET_PRESERVED } from '../server/src/routes/settings';
import { LOCAL_RESTORE_TABLES } from '../server/src/services/localBackup';
import { FACTORY_RESET_COPY, FACTORY_RESET_KEPT } from '../client/src/views/settings/DataSection';

test('the copy names exactly the tables the reset keeps', () => {
  assert.deepEqual(Object.keys(FACTORY_RESET_KEPT).sort(), [...FACTORY_RESET_PRESERVED].sort());
  for (const label of Object.values(FACTORY_RESET_KEPT)) assert.ok(FACTORY_RESET_COPY.includes(label));
  assert.match(FACTORY_RESET_COPY, /Only .* are kept\./);
});

test('the copy names the advisor history and settings the reset also clears', () => {
  for (const table of ['conversations', 'ai_memory', 'advisor_actions', 'notification_rules', 'app_preferences', 'holdings']) {
    assert.ok((LOCAL_RESTORE_TABLES as readonly string[]).includes(table), `${table} is not restorable, so not reset`);
    assert.ok(!FACTORY_RESET_PRESERVED.has(table as never), `${table} is kept by the reset`);
  }
  for (const word of ['conversations', 'memory', 'change log', 'notification', 'setting', 'holdings']) {
    assert.match(FACTORY_RESET_COPY, new RegExp(word));
  }
});
