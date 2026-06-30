import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCustomReportView,
  normalizeCustomReportViews,
  parseCustomReportViews,
  serializeCustomReportViews,
  upsertCustomReportView,
  type CustomReportView,
} from '../client/src/lib/reportViews';

function view(index: number): CustomReportView {
  return {
    id: `view_${index}`,
    label: `View ${index}`,
    tab: 'spending',
    datePreset: 'this_month',
    comparison: 'prior_month',
    createdAt: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  };
}

test('custom report view parsing drops invalid stored entries', () => {
  const parsed = normalizeCustomReportViews([
    view(1),
    { id: 'bad', label: 'Bad', tab: 'unknown', datePreset: 'this_month', comparison: 'prior_month', createdAt: 'now' },
    { id: 'missing-label', tab: 'spending', datePreset: 'this_month', comparison: 'prior_month', createdAt: 'now' },
  ]);

  assert.deepEqual(parsed.map((item) => item.id), ['view_1']);
  assert.deepEqual(parseCustomReportViews('not json'), []);
});

test('custom report view creation preserves filters and requires a name', () => {
  const created = createCustomReportView({
    label: '  Food report  ',
    tab: 'trends',
    datePreset: 'custom',
    comparison: 'same_month_last_year',
    customStart: '2026-01-01',
    customEnd: '2026-06-30',
    categoryIds: ['cat_food'],
  }, new Date('2026-06-30T12:00:00.000Z'));

  assert.equal(created.id, 'report_view_1782820800000');
  assert.equal(created.label, 'Food report');
  assert.equal(created.tab, 'trends');
  assert.equal(created.datePreset, 'custom');
  assert.equal(created.customStart, '2026-01-01');
  assert.deepEqual(created.categoryIds, ['cat_food']);
  assert.throws(() => createCustomReportView({
    label: ' ',
    tab: 'spending',
    datePreset: 'this_month',
    comparison: 'prior_period',
  }), /Report view name is required/);
});

test('custom report view upsert replaces names and caps stored views', () => {
  const existing = Array.from({ length: 12 }, (_, index) => view(index));
  const replacement = {
    ...view(99),
    label: 'View 3',
  };

  const next = upsertCustomReportView(existing, replacement);

  assert.equal(next.length, 12);
  assert.equal(next[0].id, 'view_99');
  assert.equal(next.filter((item) => item.label === 'View 3').length, 1);

  const serialized = serializeCustomReportViews(next);
  assert.deepEqual(parseCustomReportViews(serialized).map((item) => item.id), next.map((item) => item.id));

  const capped = upsertCustomReportView(existing, {
    ...view(100),
    label: 'Unique view',
  });
  assert.equal(capped.length, 12);
  assert.equal(capped.some((item) => item.id === 'view_11'), false);
});
