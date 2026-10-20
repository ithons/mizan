import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb } from './helpers/schema';
import { ADVISOR_TOOLS } from '../server/src/services/advisorChatTools';
import { AGENT_TOOLS } from '../server/src/services/advisorAgentTools';
import { ADVISOR_SYSTEM_PROMPT } from '../server/src/services/aiContext';
import { buildSchemaDoc } from '../server/src/services/schemaDoc';
import { LEGACY_TARGETS } from '../shared/routes';

// The model repeats these strings to the owner, so a screen named here that LEGACY_TARGETS retired
// sends the owner looking for a page that redirects somewhere else.
test('no model-facing text names a screen that was retired', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const texts = [
    ADVISOR_SYSTEM_PROMPT,
    ...[...ADVISOR_TOOLS, ...AGENT_TOOLS].map((tool) => JSON.stringify(tool)),
    JSON.stringify(buildSchemaDoc(db, new Date(2026, 6, 15))),
  ];
  const retired = LEGACY_TARGETS.map((target) => target.from.slice(1).replace(/-/g, ' '));
  assert.ok(retired.includes('reports') && retired.includes('cash flow'));

  for (const name of retired) {
    const pattern = new RegExp(`\\b${name}\\s+(page|screen)\\b`, 'i');
    for (const text of texts) {
      assert.doesNotMatch(text, pattern, `model-facing text names the retired ${name} screen`);
    }
  }
});
