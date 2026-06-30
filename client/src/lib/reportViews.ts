import type { ReportComparisonMode } from '@shared/types';

export const REPORT_VIEW_STORAGE_KEY = 'mizan:custom-report-views';
export const REPORT_VIEW_PREFERENCE_KEY = 'custom_report_views';
export const REPORT_VIEW_IMPORTED_STORAGE_KEY = 'mizan:custom-report-views:sqlite-imported';

export type ReportDatePreset = 'this_month' | 'last_month' | '3m' | '6m' | '12m' | 'ytd' | 'all' | 'custom';
export type ReportTab = 'spending' | 'income' | 'trends' | 'cashflow' | 'networth' | 'investments';

export interface CustomReportView {
  id: string;
  label: string;
  tab: ReportTab;
  datePreset: ReportDatePreset;
  comparison: ReportComparisonMode;
  customStart?: string;
  customEnd?: string;
  categoryIds?: string[];
  createdAt: string;
}

export interface ReportViewDraft {
  label: string;
  tab: ReportTab;
  datePreset: ReportDatePreset;
  comparison: ReportComparisonMode;
  customStart?: string;
  customEnd?: string;
  categoryIds?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isReportTab(value: unknown): value is ReportTab {
  return value === 'spending' ||
    value === 'income' ||
    value === 'trends' ||
    value === 'cashflow' ||
    value === 'networth' ||
    value === 'investments';
}

function isReportDatePreset(value: unknown): value is ReportDatePreset {
  return value === 'this_month' ||
    value === 'last_month' ||
    value === '3m' ||
    value === '6m' ||
    value === '12m' ||
    value === 'ytd' ||
    value === 'all' ||
    value === 'custom';
}

function isComparisonMode(value: unknown): value is ReportComparisonMode {
  return value === 'prior_period' ||
    value === 'prior_month' ||
    value === 'same_month_last_year' ||
    value === 'trailing_3' ||
    value === 'trailing_12';
}

function cleanCategoryIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function normalizeCustomReportViews(value: unknown): CustomReportView[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): CustomReportView[] => {
    if (!isRecord(item)) return [];
    if (typeof item.id !== 'string' || item.id.trim().length === 0) return [];
    if (typeof item.label !== 'string' || item.label.trim().length === 0) return [];
    if (!isReportTab(item.tab)) return [];
    if (!isReportDatePreset(item.datePreset)) return [];
    if (!isComparisonMode(item.comparison)) return [];
    if (typeof item.createdAt !== 'string' || item.createdAt.trim().length === 0) return [];

    const customStart = typeof item.customStart === 'string' ? item.customStart : undefined;
    const customEnd = typeof item.customEnd === 'string' ? item.customEnd : undefined;
    const categoryIds = cleanCategoryIds(item.categoryIds);

    return [{
      id: item.id.trim(),
      label: item.label.trim(),
      tab: item.tab,
      datePreset: item.datePreset,
      comparison: item.comparison,
      ...(customStart ? { customStart } : {}),
      ...(customEnd ? { customEnd } : {}),
      ...(categoryIds.length > 0 ? { categoryIds } : {}),
      createdAt: item.createdAt,
    }];
  });
}

export function parseCustomReportViews(raw: string | null): CustomReportView[] {
  if (!raw) return [];

  try {
    return normalizeCustomReportViews(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function createCustomReportView(
  draft: ReportViewDraft,
  now = new Date()
): CustomReportView {
  const label = draft.label.trim();
  if (!label) {
    throw new Error('Report view name is required');
  }

  return {
    id: `report_view_${now.getTime()}`,
    label,
    tab: draft.tab,
    datePreset: draft.datePreset,
    comparison: draft.comparison,
    ...(draft.customStart ? { customStart: draft.customStart } : {}),
    ...(draft.customEnd ? { customEnd: draft.customEnd } : {}),
    ...(draft.categoryIds && draft.categoryIds.length > 0 ? { categoryIds: draft.categoryIds } : {}),
    createdAt: now.toISOString(),
  };
}

export function upsertCustomReportView(
  views: CustomReportView[],
  nextView: CustomReportView
): CustomReportView[] {
  return [
    nextView,
    ...views.filter((view) =>
      view.id !== nextView.id && view.label.toLowerCase() !== nextView.label.toLowerCase()
    ),
  ].slice(0, 12);
}

export function serializeCustomReportViews(views: CustomReportView[]): string {
  return JSON.stringify(views);
}
