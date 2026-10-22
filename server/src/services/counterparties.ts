import type Database from 'better-sqlite3';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import { dollarizeFields, toDollars } from './money';
import type {
  CounterpartiesResponse,
  Counterparty,
  CounterpartyChannel,
  CounterpartyKind,
  CounterpartyState,
} from '../../../shared/types';

export const COUNTERPARTY_WINDOW_DAYS = 60;
export const SETTLE_TOLERANCE_CENTS = 100;
const ROOTS = ['cat_xfer_in', 'cat_xfer_out'] as const;
const MONEY_FIELDS = ['sent', 'received', 'net'] as const;

interface Row { date: string; amount: number; original_name: string }
interface Match { key: string; name: string; kind: CounterpartyKind; channel: CounterpartyChannel }

const WALLETS: ReadonlyArray<{ pattern: RegExp; match: Match }> = [
  { pattern: /\bvenmo\b/i, match: { key: 'wallet:venmo', name: 'Venmo', kind: 'wallet', channel: 'venmo' } },
  { pattern: /\bpaypal\b/i, match: { key: 'wallet:paypal', name: 'PayPal', kind: 'wallet', channel: 'paypal' } },
  { pattern: /\bwire\b/i, match: { key: 'wire', name: 'Wire transfers', kind: 'wire', channel: 'wire' } },
  {
    pattern: /\bATM\b|\bWITHDRWL\b|\bCASH DEPOSIT\b|\bBKOFAMERICA BC\b/i,
    match: { key: 'cash', name: 'Cash', kind: 'cash', channel: 'cash' },
  },
];

function titleCase(name: string): string {
  return name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

export function zelleName(descriptor: string): string | null {
  const found = /zelle payment (?:to|from)\s+(.+)$/i.exec(descriptor.trim());
  if (!found) return null;
  const rest = found[1];
  const cut = rest.search(/\s+for\s+["“”']|\s*conf#/i);
  const tokens = (cut >= 0 ? rest.slice(0, cut) : rest).trim().split(/\s+/).filter(Boolean);
  if (cut < 0 && tokens.length > 1) tokens.pop();
  return tokens.length > 0 ? tokens.join(' ') : null;
}

function personKey(name: string): string {
  const tokens = name.toLowerCase().split(/\s+/);
  const kept = tokens.length > 2 ? tokens.filter((t) => t.length > 1) : tokens;
  return `person:${kept.join(' ')}`;
}

export function classifyCounterparty(descriptor: string): Match | null {
  const person = zelleName(descriptor);
  if (person) return { key: personKey(person), name: titleCase(person), kind: 'person', channel: 'zelle' };
  return WALLETS.find((w) => w.pattern.test(descriptor))?.match ?? null;
}

function eligibleRows(db: Database.Database): Row[] {
  return db.prepare(`
    SELECT t.date, t.amount, t.original_name
    FROM transactions t
    WHERE t.category_id IN (SELECT id FROM categories WHERE id IN (?, ?) OR parent_id IN (?, ?))
      AND t.pending = 0
      AND COALESCE(t.duplicate_status, 'none') <> 'confirmed'
      AND NOT EXISTS (
        SELECT 1 FROM transactions p
        WHERE p.transfer_pair_id = t.transfer_pair_id AND p.id <> t.id AND p.account_id <> t.account_id
      )
    ORDER BY t.date ASC, t.id ASC
  `).all(...ROOTS, ...ROOTS) as Row[];
}

interface Tally { match: Match; sent: number; received: number; rows: number; first: string; last: string }

function judge(kind: CounterpartyKind, net: number): CounterpartyState | null {
  if (kind !== 'person') return null;
  if (Math.abs(net) <= SETTLE_TOLERANCE_CENTS) return 'settled';
  return net < 0 ? 'sent_more' : 'received_more';
}

function toCounterparty(t: Tally, today: Date): Counterparty {
  const net = t.received - t.sent;
  const state = judge(t.match.kind, net);
  const days = differenceInCalendarDays(today, parseISO(t.last));
  return {
    ...t.match,
    sent: t.sent,
    received: t.received,
    net,
    rows: t.rows,
    first_date: t.first,
    last_date: t.last,
    days_since_last: days,
    state,
    older_than_window: state !== null && state !== 'settled' && days > COUNTERPARTY_WINDOW_DAYS,
  };
}

const STATE_ORDER: Record<CounterpartyState, number> = { sent_more: 0, received_more: 1, settled: 2 };

function byStateThenSize(a: Counterparty, b: Counterparty): number {
  const order = STATE_ORDER[a.state ?? 'settled'] - STATE_ORDER[b.state ?? 'settled'];
  if (order !== 0) return order;
  return Math.abs(b.net) - Math.abs(a.net) || b.last_date.localeCompare(a.last_date) || a.key.localeCompare(b.key);
}

/** Cents. Money between the owner and people, wallets the owner does not track, and cash. */
export function findCounterparties(db: Database.Database, today = new Date()): CounterpartiesResponse {
  const tallies = new Map<string, Tally>();
  const unclassified = { rows: 0, sent: 0, received: 0 };
  for (const row of eligibleRows(db)) {
    const match = classifyCounterparty(row.original_name);
    const sent = row.amount < 0 ? -row.amount : 0;
    const received = row.amount > 0 ? row.amount : 0;
    if (!match) {
      unclassified.rows += 1;
      unclassified.sent += sent;
      unclassified.received += received;
      continue;
    }
    const tally = tallies.get(match.key) ?? { match, sent: 0, received: 0, rows: 0, first: row.date, last: row.date };
    tally.match = match;
    tally.sent += sent;
    tally.received += received;
    tally.rows += 1;
    tally.last = row.date;
    tallies.set(match.key, tally);
  }
  const all = [...tallies.values()].map((t) => toCounterparty(t, today));
  return {
    as_of: format(today, 'yyyy-MM-dd'),
    window_days: COUNTERPARTY_WINDOW_DAYS,
    settle_tolerance: SETTLE_TOLERANCE_CENTS,
    people: all.filter((c) => c.kind === 'person').sort(byStateThenSize),
    channels: all.filter((c) => c.kind !== 'person').sort((a, b) => b.sent + b.received - (a.sent + a.received)),
    unclassified,
  };
}

export function counterpartiesToDollars(reading: CounterpartiesResponse): CounterpartiesResponse {
  return {
    ...reading,
    settle_tolerance: toDollars(reading.settle_tolerance),
    people: reading.people.map((c) => dollarizeFields(c, MONEY_FIELDS)),
    channels: reading.channels.map((c) => dollarizeFields(c, MONEY_FIELDS)),
    unclassified: dollarizeFields(reading.unclassified, ['sent', 'received']),
  };
}
