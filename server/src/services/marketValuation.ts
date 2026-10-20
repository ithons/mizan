import type Database from 'better-sqlite3';
import { addDays, format, parseISO } from 'date-fns';
import { DOLLAR_TICKERS } from './priceHistory';

/** A close older than this is too stale to value a day with. Covers weekends and market holidays. */
const MAX_PRICE_AGE_DAYS = 5;
const DUST = 1e-9;
/** Carried-forward positions must value within this of the recorded holdings they meet, or the days since the last check are dropped. */
const AGREEMENT_CENTS = 100;

interface QuantityRow { date: string; security_id: string | null; quantity: number | null; is_internal_trade: number; category_id: string | null }

const TRADE_CATEGORIES = new Set(['cat_inv_buy', 'cat_inv_sell', 'cat_crypto_buy', 'cat_crypto_sell']);

/**
 * Each market-driven account's value, in cents, on every day its positions and prices are both
 * known: positions are the account's recorded holdings on a day that has them (statement month-ends
 * and the app's own captures), carried forward through rows that state a quantity; prices are the
 * day's close, or the latest within five days. Carried positions count only once the next recorded
 * holdings confirm them to within a dollar, so a deposit or sale the ledger holds without a
 * quantity drops the stretch it would have mis-valued, and days after the last recorded holdings
 * are left out. A day after a trade the ledger records without a
 * quantity has no known positions until the next recorded holdings, and is left out rather than
 * valued on stale positions. US dollars sitting at Coinbase are not a position the ledger tracks
 * (its fiat legs carry no quantity), so they are left out; they are swept the day they arrive.
 */
export function pricedMarketValues(db: Database.Database, accountIds: readonly string[], today = format(new Date(), 'yyyy-MM-dd')): Map<string, Map<string, number>> {
  const tickers = new Map((db.prepare('SELECT id, ticker FROM securities').all() as Array<{ id: string; ticker: string | null }>).map((s) => [s.id, s.ticker ?? '']));
  const closes = new Map<string, Map<string, number>>();
  for (const row of db.prepare('SELECT security_id, date, close FROM security_prices').all() as Array<{ security_id: string; date: string; close: number }>) {
    const series = closes.get(row.security_id) ?? new Map<string, number>();
    series.set(row.date, row.close);
    closes.set(row.security_id, series);
  }
  const priceOn = (securityId: string, day: string): number | null => {
    if (DOLLAR_TICKERS.has(tickers.get(securityId) ?? '')) return 1;
    const series = closes.get(securityId);
    if (!series) return null;
    for (let back = 0, d = parseISO(day); back <= MAX_PRICE_AGE_DAYS; back++, d = addDays(d, -1)) {
      const close = series.get(format(d, 'yyyy-MM-dd'));
      if (close !== undefined) return close;
    }
    return null;
  };

  const out = new Map<string, Map<string, number>>();
  for (const accountId of accountIds) {
    const rows = db.prepare(`
      SELECT date, security_id, quantity, is_internal_trade, category_id FROM transactions
      WHERE account_id = ? AND pending = 0 ORDER BY date
    `).all(accountId) as QuantityRow[];
    if (rows.length === 0) continue;
    const recorded = new Map<string, Map<string, number>>();
    for (const h of db.prepare('SELECT date, security_id, quantity FROM holdings_history WHERE account_id = ?').all(accountId) as Array<{ date: string; security_id: string; quantity: number }>) {
      const day = recorded.get(h.date) ?? new Map<string, number>();
      day.set(h.security_id, h.quantity);
      recorded.set(h.date, day);
    }
    const byDay = new Map<string, QuantityRow[]>();
    for (const row of rows) byDay.set(row.date, [...(byDay.get(row.date) ?? []), row]);

    if (recorded.size === 0) continue;
    const valueOf = (held: Map<string, number>, day: string): number | null => {
      let cents = 0;
      for (const [securityId, quantity] of held) {
        if (Math.abs(quantity) < DUST || tickers.get(securityId) === 'USD') continue;
        const price = priceOn(securityId, day);
        if (price === null) return null;
        cents += quantity * price * 100;
      }
      return Math.round(cents);
    };

    const values = new Map<string, number>();
    let unconfirmed: string[] = [];
    let positions: Map<string, number> | null = new Map();
    for (let d = parseISO(rows[0].date); format(d, 'yyyy-MM-dd') <= today; d = addDays(d, 1)) {
      const day = format(d, 'yyyy-MM-dd');
      const held = recorded.get(day);
      if (held) {
        const carried = positions ? valueOf(positions, day) : null;
        const actual = valueOf(held, day);
        if (carried === null || actual === null || Math.abs(carried - actual) > AGREEMENT_CENTS) {
          for (const stale of unconfirmed) values.delete(stale);
        }
        unconfirmed = [];
        positions = new Map(held);
      } else if (positions) {
        for (const row of byDay.get(day) ?? []) {
          const isTrade = row.is_internal_trade === 1 || TRADE_CATEGORIES.has(row.category_id ?? '');
          if (row.quantity === null || row.security_id === null) {
            if (isTrade) { positions = null; break; }
            continue;
          }
          positions.set(row.security_id, (positions.get(row.security_id) ?? 0) + row.quantity);
        }
      }
      if (!positions) continue;
      const cents = valueOf(positions, day);
      if (cents === null) continue;
      values.set(day, cents);
      if (!held) unconfirmed.push(day);
    }
    for (const stale of unconfirmed) values.delete(stale);
    out.set(accountId, values);
  }
  return out;
}
