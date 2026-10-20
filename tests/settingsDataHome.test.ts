/**
 * Exports, backup, restore and Delete All Data have one home, DataSection, under a row whose label
 * says what it holds. Settings used to offer a second backup and a CSV export titled "Export all
 * data" that wrote transactions only, while restore and the factory reset sat behind "CSV import".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

test('Settings has no second export path and no row labelled for only part of the panel', () => {
  const settings = read('client/src/views/settings/Settings.tsx');
  assert.doesNotMatch(settings, /settingsApi\.export/);
  assert.doesNotMatch(settings, /title="Export all data"/);
  assert.doesNotMatch(settings, /title="CSV import"/);
  assert.equal(settings.match(/<DataSection \/>/g)?.length, 1);
});

test('HEALTHY: DataSection still offers every export, restore and the reset', () => {
  const data = read('client/src/views/settings/DataSection.tsx');
  for (const call of ['settingsApi.exportCsv()', "settingsApi.exportCsv('monarch')", 'settingsApi.exportBackupJson()']) {
    assert.ok(data.includes(call), call);
  }
  assert.match(data, /Export transactions CSV/);
  assert.match(data, /Restore Backup/);
  assert.match(data, /Delete All Data/);
});
