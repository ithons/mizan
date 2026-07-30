import type Database from 'better-sqlite3';
import type { Holding, Security } from '../../../shared/types';
import { toCents } from './money';

interface HoldingRow {
  id: string;
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number;
  institution_value: number;
  provider_cost_basis: number | null;
  cost_basis: number | null;
  effective_cost_basis: number | null;
  manual_cost_basis: number | null;
  manual_cost_basis_note: string | null;
  manual_cost_basis_updated_at: string | null;
  cost_basis_quality: 'manual' | 'provider' | 'missing';
  currency: string;
  updated_at: string;
  ticker: string | null;
  security_name: string | null;
  security_type: string | null;
  sector: string | null;
  sector_source: string | null;
}

interface SecurityRow {
  id: string;
  ticker: string | null;
  name: string;
  type: Security['type'];
  currency: string;
  sector: string | null;
  sector_source: string | null;
}

export interface UpdateHoldingCostBasisInput {
  manual_cost_basis: number | null;
  manual_cost_basis_note?: string | null;
}

export interface UpdateSecurityMetadataInput {
  sector: string | null;
  sector_source?: string | null;
}

function httpError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// A stored basis of 0 is a provider that declined to report one (migration 043), so it is
// unknown rather than known-to-be-nothing. Reading it as a number makes the whole position
// unrealized gain and labels that 'provider' quality. Guard it here, at the one select every
// holding read goes through, rather than at each caller.
const PROVIDER_BASIS = 'CASE WHEN h.cost_basis > 0 THEN h.cost_basis END';

const holdingSelect = `
  SELECT
    h.id,
    h.account_id,
    h.security_id,
    h.quantity,
    h.institution_price,
    h.institution_value,
    ${PROVIDER_BASIS} AS provider_cost_basis,
    COALESCE(h.manual_cost_basis, ${PROVIDER_BASIS}) AS cost_basis,
    COALESCE(h.manual_cost_basis, ${PROVIDER_BASIS}) AS effective_cost_basis,
    h.manual_cost_basis,
    h.manual_cost_basis_note,
    h.manual_cost_basis_updated_at,
    CASE
      WHEN h.manual_cost_basis IS NOT NULL THEN 'manual'
      WHEN h.cost_basis > 0 THEN 'provider'
      ELSE 'missing'
    END AS cost_basis_quality,
    h.currency,
    h.updated_at,
    s.ticker,
    s.name AS security_name,
    s.type AS security_type,
    s.sector,
    s.sector_source
  FROM holdings h
  JOIN securities s ON s.id = h.security_id
`;

function holdingFromRow(row: HoldingRow): Holding {
  // Position values and cost-basis figures stay in integer cents; the route boundary
  // (routes/investments.ts) dollarizes them. institution_price is a per-unit price and
  // quantity is a share count, so neither is money-in-cents and both pass through untouched.
  return {
    id: row.id,
    account_id: row.account_id,
    security_id: row.security_id,
    quantity: row.quantity,
    institution_price: row.institution_price,
    institution_value: row.institution_value,
    provider_cost_basis: row.provider_cost_basis,
    cost_basis: row.cost_basis,
    effective_cost_basis: row.effective_cost_basis,
    manual_cost_basis: row.manual_cost_basis,
    manual_cost_basis_note: row.manual_cost_basis_note,
    manual_cost_basis_updated_at: row.manual_cost_basis_updated_at,
    cost_basis_quality: row.cost_basis_quality,
    currency: row.currency,
    updated_at: row.updated_at,
    ticker: row.ticker,
    security_name: row.security_name,
    security_type: row.security_type,
    sector: row.sector,
    sector_source: row.sector_source,
  };
}

function securityFromRow(row: SecurityRow): Security {
  return {
    id: row.id,
    ticker: row.ticker,
    name: row.name,
    type: row.type,
    currency: row.currency,
    sector: row.sector,
    sector_source: row.sector_source,
  };
}

export function listHoldingsWithMetadata(
  db: Database.Database,
  accountId?: string | null
): Holding[] {
  const where = accountId ? 'WHERE h.account_id = ?' : '';
  const params = accountId ? [accountId] : [];
  return (db.prepare(`
    ${holdingSelect}
    ${where}
    ORDER BY h.institution_value DESC
  `).all(...params) as HoldingRow[]).map(holdingFromRow);
}

export function getHoldingWithMetadata(
  db: Database.Database,
  holdingId: string
): Holding | null {
  const row = db.prepare(`
    ${holdingSelect}
    WHERE h.id = ?
  `).get(holdingId) as HoldingRow | undefined;
  return row ? holdingFromRow(row) : null;
}

export function setManualCostBasis(
  db: Database.Database,
  holdingId: string,
  input: UpdateHoldingCostBasisInput
): Holding {
  const existing = db.prepare('SELECT id FROM holdings WHERE id = ?').get(holdingId);
  if (!existing) throw httpError('Holding not found', 404);

  if (input.manual_cost_basis != null && !Number.isFinite(input.manual_cost_basis)) {
    throw httpError('manual_cost_basis must be a finite number', 400);
  }

  const note = input.manual_cost_basis == null
    ? null
    : input.manual_cost_basis_note?.trim() || null;
  const updatedAt = input.manual_cost_basis == null ? null : new Date().toISOString();

  // Inbound override is dollars (Zod-validated user input); the column is integer cents.
  const manualCostBasisCents = input.manual_cost_basis == null ? null : toCents(input.manual_cost_basis);

  db.prepare(`
    UPDATE holdings
    SET manual_cost_basis = ?,
        manual_cost_basis_note = ?,
        manual_cost_basis_updated_at = ?
    WHERE id = ?
  `).run(manualCostBasisCents, note, updatedAt, holdingId);

  const holding = getHoldingWithMetadata(db, holdingId);
  if (!holding) throw httpError('Holding not found', 404);
  return holding;
}

export interface HoldingHistoryPoint {
  date: string;
  quantity: number;
  institution_price: number;
  institution_value: number;
  cost_basis: number | null;
}

export function getHoldingHistory(
  db: Database.Database,
  holdingId: string,
  days = 90
): HoldingHistoryPoint[] {
  const holding = db.prepare('SELECT account_id, security_id FROM holdings WHERE id = ?').get(holdingId) as
    | { account_id: string; security_id: string }
    | undefined;
  if (!holding) throw httpError('Holding not found', 404);

  // Guard against a non-numeric ?days= (parseInt → NaN) producing '-NaN days', which SQLite
  // evaluates to NULL and silently returns an empty series. Fall back to the 90-day default.
  const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 90;

  // institution_value and cost_basis stay in integer cents (dollarized at the route);
  // institution_price (per-unit) and quantity (share count) are not money.
  return db.prepare(`
    SELECT date, quantity, institution_price, institution_value, cost_basis
    FROM holdings_history
    WHERE account_id = ? AND security_id = ? AND date >= date('now', ?)
    ORDER BY date ASC
  `).all(holding.account_id, holding.security_id, `-${windowDays} days`) as HoldingHistoryPoint[];
}

export function setSecurityMetadata(
  db: Database.Database,
  securityId: string,
  input: UpdateSecurityMetadataInput
): Security {
  const existing = db.prepare('SELECT id FROM securities WHERE id = ?').get(securityId);
  if (!existing) throw httpError('Security not found', 404);

  const sector = input.sector?.trim() || null;
  const sectorSource = sector ? input.sector_source?.trim() || 'manual' : null;
  db.prepare(`
    UPDATE securities
    SET sector = ?,
        sector_source = ?
    WHERE id = ?
  `).run(sector, sectorSource, securityId);

  const row = db.prepare(`
    SELECT id, ticker, name, type, currency, sector, sector_source
    FROM securities
    WHERE id = ?
  `).get(securityId) as SecurityRow | undefined;
  if (!row) throw httpError('Security not found', 404);
  return securityFromRow(row);
}
