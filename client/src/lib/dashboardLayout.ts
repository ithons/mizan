export const DASHBOARD_LAYOUT_STORAGE_KEY = 'mizan:dashboard-layout';

export type DashboardCardId =
  | 'overview'
  | 'signals'
  | 'sync_activity'
  | 'asset_breakdown'
  | 'spending_bills'
  | 'planning'
  | 'recent_transactions';

export interface DashboardCardDefinition {
  id: DashboardCardId;
  label: string;
  detail: string;
}

export interface DashboardLayoutItem {
  id: DashboardCardId;
  hidden: boolean;
  pinned: boolean;
}

export const DASHBOARD_CARD_DEFINITIONS: DashboardCardDefinition[] = [
  {
    id: 'overview',
    label: 'Overview Stats',
    detail: 'Net worth, monthly spend, income, and top category',
  },
  {
    id: 'signals',
    label: 'Signals And Trust',
    detail: 'Insights, data quality, and sync health',
  },
  {
    id: 'sync_activity',
    label: 'Sync Activity',
    detail: 'Recent provider sync runs and failures',
  },
  {
    id: 'asset_breakdown',
    label: 'Asset Breakdown',
    detail: 'Net worth composition by asset type',
  },
  {
    id: 'spending_bills',
    label: 'Spending And Bills',
    detail: 'Category spending and the next 30 days',
  },
  {
    id: 'planning',
    label: 'Planning',
    detail: 'Budgets, goals, and investment snapshot',
  },
  {
    id: 'recent_transactions',
    label: 'Recent Transactions',
    detail: 'Latest monthly activity',
  },
];

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayoutItem[] = DASHBOARD_CARD_DEFINITIONS.map((card) => ({
  id: card.id,
  hidden: false,
  pinned: false,
}));

const VALID_CARD_IDS = new Set<DashboardCardId>(DASHBOARD_CARD_DEFINITIONS.map((card) => card.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDashboardCardId(value: unknown): value is DashboardCardId {
  return typeof value === 'string' && VALID_CARD_IDS.has(value as DashboardCardId);
}

function cloneDefaultLayout(): DashboardLayoutItem[] {
  return DEFAULT_DASHBOARD_LAYOUT.map((item) => ({ ...item }));
}

export function normalizeDashboardLayout(value: unknown): DashboardLayoutItem[] {
  if (!Array.isArray(value)) return cloneDefaultLayout();

  const seen = new Set<DashboardCardId>();
  const normalized = value.flatMap((item): DashboardLayoutItem[] => {
    if (!isRecord(item) || !isDashboardCardId(item.id) || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{
      id: item.id,
      hidden: item.hidden === true,
      pinned: item.pinned === true,
    }];
  });

  const missing = cloneDefaultLayout().filter((item) => !seen.has(item.id));
  return [...normalized, ...missing];
}

export function parseDashboardLayout(raw: string | null): DashboardLayoutItem[] {
  if (!raw) return cloneDefaultLayout();

  try {
    return normalizeDashboardLayout(JSON.parse(raw));
  } catch {
    return cloneDefaultLayout();
  }
}

export function serializeDashboardLayout(layout: DashboardLayoutItem[]): string {
  return JSON.stringify(normalizeDashboardLayout(layout));
}

export function visibleDashboardCardIds(layout: DashboardLayoutItem[]): DashboardCardId[] {
  const normalized = normalizeDashboardLayout(layout).filter((item) => !item.hidden);
  return [
    ...normalized.filter((item) => item.pinned).map((item) => item.id),
    ...normalized.filter((item) => !item.pinned).map((item) => item.id),
  ];
}

export function moveDashboardCard(
  layout: DashboardLayoutItem[],
  cardId: DashboardCardId,
  direction: 'up' | 'down'
): DashboardLayoutItem[] {
  const next = normalizeDashboardLayout(layout);
  const index = next.findIndex((item) => item.id === cardId);
  if (index < 0) return next;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= next.length) return next;

  const current = next[index];
  next[index] = next[targetIndex];
  next[targetIndex] = current;
  return next;
}

export function setDashboardCardHidden(
  layout: DashboardLayoutItem[],
  cardId: DashboardCardId,
  hidden: boolean
): DashboardLayoutItem[] {
  return normalizeDashboardLayout(layout).map((item) =>
    item.id === cardId ? { ...item, hidden } : item
  );
}

export function setDashboardCardPinned(
  layout: DashboardLayoutItem[],
  cardId: DashboardCardId,
  pinned: boolean
): DashboardLayoutItem[] {
  return normalizeDashboardLayout(layout).map((item) =>
    item.id === cardId ? { ...item, pinned } : item
  );
}
