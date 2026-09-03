import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * The ledger's order is the ledger's, not the caller's.
 *
 * `GET /api/transactions` accepted `sortBy` and `sortDir` for the life of the repo and no screen
 * ever sent either: the only occurrences in `client/src` were the two lines in `api.ts` that
 * appended them. That is a dropped capability by this repo's own rule, one layer below a fetcher
 * with no caller, and it had nowhere to be wired to. The ledger is a day-grouped list on a date
 * spine whose today rule is the only thing separating what is expected from what has happened;
 * sorting it by amount destroys that rule, which is why `rebuild-part-3.md` Phase 14's sortable
 * headers were declined rather than deferred.
 *
 * The capability is NOT gone from the service. `advisorChatTools.ts` is a real caller, and the
 * ordering has to exist somewhere for `listTransactions` to be deterministic.
 */
test('nothing in the client can ask the ledger to reorder itself', () => {
  const offenders = walk(join(ROOT, 'client', 'src'))
    .filter((f) => /\bsort(By|Dir)\b/.test(readFileSync(f, 'utf8')))
    .map((f) => f.replace(ROOT, ''));
  assert.deepEqual(offenders, [], 'a client caller can set the ledger sort again');

  const types = read('shared/types/index.ts');
  const filters = types.slice(types.indexOf('export interface TransactionFilters'));
  assert.ok(!/sortBy\?:/.test(filters.slice(0, 900)), 'TransactionFilters advertises a sort again');
});

test('the route pins the order rather than reading it off the wire', () => {
  const route = read('server/src/routes/transactions.ts');
  assert.match(route, /sortBy: 'date',/, 'the ledger route lost its fixed order');
  assert.match(route, /sortDir: 'desc',/);
  assert.ok(!/parseSortBy|parseSortDir/.test(route), 'the route parses a sort from the query again');
  assert.ok(!/query\.sortBy|query\.sortDir/.test(route), 'the route reads a sort off the wire again');
});

test('the service keeps the ordering, because it has a real caller', () => {
  // The silence half: this is a deletion, and a deletion that took the working capability with it
  // would be the failure. `listTransactions` still orders, and the AI tool still asks for date desc.
  const svc = read('server/src/services/transactions.ts');
  assert.match(svc, /function transactionOrderBy\(/, 'the service lost its ordering entirely');
  assert.match(svc, /ORDER BY \$\{transactionOrderBy\(/, 'listTransactions no longer orders');
  const tools = read('server/src/services/advisorChatTools.ts');
  assert.match(tools, /sortBy: 'date'/, 'the one real caller of the sort stopped calling it');
});
