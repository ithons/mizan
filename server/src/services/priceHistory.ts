import type Database from 'better-sqlite3';
import { addDays, format, parseISO } from 'date-fns';
import { MARKET_DRIVEN_TYPES } from './balanceHistory';
import { getPreference, setPreference } from './preferences';

/** Tickers worth exactly a dollar, valued without a lookup. USD itself is left out of positions (see marketValuation.ts). */
export const DOLLAR_TICKERS = new Set(['USDC', 'SPAXX']);
const CANDLES_PER_REQUEST = 300;

export type PriceSource = 'coinbase_exchange' | 'yahoo';

interface Wanted { security_id: string; ticker: string; type: string; from: string }

/** Every priced security a market-driven account has held, from the account's first row. */
export function securitiesToPrice(db: Database.Database): Wanted[] {
  const types = [...MARKET_DRIVEN_TYPES];
  return db.prepare(`
    SELECT s.id AS security_id, s.ticker, s.type, MIN(x.date) AS "from"
    FROM (
      SELECT t.security_id, (SELECT MIN(date) FROM transactions WHERE account_id = t.account_id) AS date
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.security_id IS NOT NULL AND a.type IN (${types.map(() => '?').join(',')})
      UNION ALL
      SELECT h.security_id, (SELECT MIN(date) FROM transactions WHERE account_id = h.account_id)
      FROM holdings_history h
    ) x JOIN securities s ON s.id = x.security_id
    WHERE s.ticker IS NOT NULL AND s.ticker <> 'USD'
    GROUP BY s.id
  `).all(...types).filter((row) => !DOLLAR_TICKERS.has((row as Wanted).ticker)) as Wanted[];
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (mizan price history)' } });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  return response.json();
}

/** Daily closes from Coinbase Exchange's public candles, keyed by the UTC day each candle covers. */
async function coinbaseCloses(ticker: string, from: string, to: string): Promise<Map<string, number>> {
  const closes = new Map<string, number>();
  for (let start = parseISO(from); format(start, 'yyyy-MM-dd') <= to; start = addDays(start, CANDLES_PER_REQUEST)) {
    const end = addDays(start, CANDLES_PER_REQUEST - 1);
    const url = `https://api.exchange.coinbase.com/products/${ticker}-USD/candles?granularity=86400`
      + `&start=${format(start, 'yyyy-MM-dd')}T00:00:00Z&end=${format(end, 'yyyy-MM-dd')}T23:59:59Z`;
    const candles = await getJson(url);
    if (!Array.isArray(candles)) throw new Error(`Unexpected candles for ${ticker}`);
    for (const candle of candles as number[][]) {
      closes.set(new Date(candle[0] * 1000).toISOString().slice(0, 10), candle[4]);
    }
  }
  return closes;
}

/** Daily closes from Yahoo's public chart data, keyed by the exchange's local trading day. */
async function yahooCloses(ticker: string, from: string, to: string): Promise<Map<string, number>> {
  const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
  const body = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d`) as {
    chart?: { result?: Array<{ meta: { gmtoffset: number }; timestamp?: number[]; indicators: { quote: Array<{ close: Array<number | null> }> } }> };
  };
  const result = body.chart?.result?.[0];
  if (!result) throw new Error(`No chart for ${ticker}`);
  const closes = new Map<string, number>();
  (result.timestamp ?? []).forEach((ts, i) => {
    const close = result.indicators.quote[0].close[i];
    if (close != null) closes.set(new Date((ts + result.meta.gmtoffset) * 1000).toISOString().slice(0, 10), close);
  });
  return closes;
}

/**
 * Fetch and store the daily closes each held security is missing, from its first holder's first
 * row to today. Only ticker symbols and dates leave the machine. A source that fails for one
 * security is reported and the rest continue.
 */
export async function refreshSecurityPrices(db: Database.Database, today = format(new Date(), 'yyyy-MM-dd')) {
  const insert = db.prepare(`
    INSERT INTO security_prices (security_id, date, close, source, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (security_id, date) DO UPDATE SET close = excluded.close, source = excluded.source, fetched_at = excluded.fetched_at
  `);
  const latest = db.prepare('SELECT MAX(date) AS d FROM security_prices WHERE security_id = ?');
  const report: Array<{ ticker: string; source: PriceSource; stored: number; error?: string }> = [];
  for (const wanted of securitiesToPrice(db)) {
    const source: PriceSource = wanted.type === 'crypto' ? 'coinbase_exchange' : 'yahoo';
    const have = (latest.get(wanted.security_id) as { d: string | null }).d;
    const from = have && have > wanted.from ? format(addDays(parseISO(have), -3), 'yyyy-MM-dd') : wanted.from;
    try {
      const closes = source === 'coinbase_exchange' ? await coinbaseCloses(wanted.ticker, from, today) : await yahooCloses(wanted.ticker, from, today);
      const now = new Date().toISOString();
      db.transaction(() => {
        for (const [date, close] of closes) if (date <= today) insert.run(wanted.security_id, date, close, source, now);
      })();
      report.push({ ticker: wanted.ticker, source, stored: closes.size });
    } catch (err) {
      report.push({ ticker: wanted.ticker, source, stored: 0, error: (err as Error).message });
    }
  }
  return report;
}

const REFRESHED_KEY = 'security_prices_refreshed_on';

/** The sync's once-a-day refresh: a no-op when today's has already run. */
export async function refreshSecurityPricesDaily(db: Database.Database, today = format(new Date(), 'yyyy-MM-dd')) {
  if (getPreference(db, REFRESHED_KEY)?.value === today) return null;
  const report = await refreshSecurityPrices(db, today);
  setPreference(db, REFRESHED_KEY, today);
  return report;
}
