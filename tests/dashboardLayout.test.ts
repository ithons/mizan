import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DASHBOARD_LAYOUT,
  moveDashboardCard,
  normalizeDashboardLayout,
  parseDashboardLayout,
  serializeDashboardLayout,
  setDashboardCardHidden,
  setDashboardCardPinned,
  visibleDashboardCardIds,
  type DashboardLayoutItem,
} from '../client/src/lib/dashboardLayout';

function ids(layout: DashboardLayoutItem[]): string[] {
  return layout.map((item) => item.id);
}

test('dashboard layout parsing falls back to the complete default layout', () => {
  assert.deepEqual(parseDashboardLayout('not json'), DEFAULT_DASHBOARD_LAYOUT);
  assert.deepEqual(parseDashboardLayout(null), DEFAULT_DASHBOARD_LAYOUT);
});

test('dashboard layout normalization drops invalid entries and appends missing cards', () => {
  const normalized = normalizeDashboardLayout([
    { id: 'recent_transactions', hidden: true, pinned: true },
    { id: 'unknown', hidden: true, pinned: true },
    { id: 'recent_transactions', hidden: false, pinned: false },
    { id: 'overview', hidden: false, pinned: false },
  ]);

  assert.deepEqual(ids(normalized).slice(0, 2), ['recent_transactions', 'overview']);
  assert.equal(normalized[0].hidden, true);
  assert.equal(normalized[0].pinned, true);
  assert.equal(new Set(ids(normalized)).size, DEFAULT_DASHBOARD_LAYOUT.length);
  assert.equal(normalized.length, DEFAULT_DASHBOARD_LAYOUT.length);
});

test('dashboard card movement respects boundaries', () => {
  const movedDown = moveDashboardCard(DEFAULT_DASHBOARD_LAYOUT, 'overview', 'down');
  assert.deepEqual(ids(movedDown).slice(0, 2), ['signals', 'overview']);

  const movedUp = moveDashboardCard(movedDown, 'overview', 'up');
  assert.deepEqual(ids(movedUp).slice(0, 2), ['overview', 'signals']);

  const firstStillFirst = moveDashboardCard(DEFAULT_DASHBOARD_LAYOUT, 'overview', 'up');
  assert.deepEqual(ids(firstStillFirst), ids(DEFAULT_DASHBOARD_LAYOUT));
});

test('dashboard visible cards place pinned cards first and exclude hidden cards', () => {
  const hidden = setDashboardCardHidden(DEFAULT_DASHBOARD_LAYOUT, 'signals', true);
  const pinned = setDashboardCardPinned(hidden, 'recent_transactions', true);

  assert.deepEqual(visibleDashboardCardIds(pinned).slice(0, 3), [
    'recent_transactions',
    'overview',
    'sync_activity',
  ]);
  assert.equal(visibleDashboardCardIds(pinned).includes('signals'), false);
});

test('dashboard layout serialization normalizes stored order', () => {
  const layout = setDashboardCardPinned(
    setDashboardCardHidden(DEFAULT_DASHBOARD_LAYOUT, 'asset_breakdown', true),
    'planning',
    true
  );

  const parsed = parseDashboardLayout(serializeDashboardLayout(layout));
  assert.deepEqual(parsed, layout);
});
