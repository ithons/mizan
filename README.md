# Mizān

A personal finance application for one person, running on that person's own machine.

Single owner, no accounts, no multi-tenancy, no auth layer. It connects to SimpleFIN and
Coinbase for data, and to Anthropic for the advisor. The AI is structural rather than
bolted on: once a key is configured it categorizes transactions and writes merchant rules
on its own, and everything it does is listed and reversible in Settings.

## What it does

Accounts come from SimpleFIN and Coinbase, or you add them manually, covering bank,
credit, investment, and crypto. Transactions can be searched, filtered, split, and entered
by hand, and anything not covered by a provider comes in by CSV.

Review is a worklist for everything needing a decision: uncategorized transactions grouped
by merchant, suggested merchant rules, unconfirmed recurring bills, and duplicate or
transfer candidates. It supports bulk categorization, because that is what the list is for.

Budgets are per-category and monthly with rollover, arranged into custom groups. Goals
cover saving and debt payoff, and can be linked to a real account balance so progress
tracks reality instead of a number you maintain. Recurring bills and subscriptions are
detected from transaction history, with forecasted upcoming occurrences and one-off skip,
snooze, and adjust overrides.

Investments track holdings across equities, funds, and crypto with cost basis, unrealized
gain and loss, and sector and asset-class allocation, including manual cost-basis
overrides for the providers that do not return one. Net worth is snapshotted historically
and charted across liquid, investment, crypto, and liability buckets.

The AI Advisor is a command-palette-style instant heuristic layer plus a real
conversational LLM chat with full financial context. See [AI Architecture](#ai-architecture).

## Prerequisites

- Node.js 20+
- npm

## Install & Run

```bash
git clone <repo-url> mizan
cd mizan
npm install

# Development (hot reload; single process serves both API and client)
npm run dev
# -> http://localhost:3001

# Production
npm run build
npm start
# -> http://localhost:3001
```

`better-sqlite3` is a native module compiled against your Node version. If you switch Node
versions, run `npm rebuild better-sqlite3`.

Mizān syncs on startup and hourly by default, and the background AI review runs after each
sync. Both are switchable via the environment variables below.

## Environment Variables

Copy `.env.example` to `.env` and fill in what you need. `.env` is gitignored, and nothing
in it ever leaves your machine except via the specific outbound calls it configures.

| Variable | Required | Purpose |
|---|---|---|
| `COINBASE_KEY_NAME` / `COINBASE_PRIVATE_KEY` | No | Coinbase Advanced Trade API credentials. Optional here: you can instead paste them into **Settings → Coinbase** in the UI, where they're encrypted at rest. Values from `.env` take precedence over stored ones. |
| `ANTHROPIC_API_KEY` | No | Enables the AI Advisor chat (`/api/ai/chat`) and the background AI review worker. Without it, the app still runs fully. The local heuristic advisor, command palette, and every other feature work with no key at all. |
| `CORS_ORIGIN` | No, production only | Only needed if the client is hosted at a different origin than this server. The default single-process deployment doesn't need it. The app has no auth layer, so anything reachable at this origin can read and write your financial data. Only set it to an origin you control. |
| `MIZAN_AUTO_SYNC_ON_STARTUP` | No | **On by default.** Runs a full sync ~2s after the server starts, skipped if the last sync was within 10 minutes (so `tsx watch` restarts don't hammer providers). Set to `false` to disable. |
| `MIZAN_SYNC_INTERVAL_MINUTES` | No | **On by default, every 60 minutes.** Set to another positive integer to change the cadence, or `0` to disable. |
| `MIZAN_ALLOWED_HOSTS` | No | Extra `host[:port]` values the local request guard should accept, comma-separated. Only needed for a non-standard hostname. |
| `PORT` | No | Server port. Defaults to `3001`. |

## Architecture

Express and better-sqlite3 on the server, React with Vite, TanStack Query, and Zustand on
the client, and shared Zod schemas and TypeScript types in `shared/`. In development,
[`vite-express`](https://github.com/szymmis/vite-express) serves both the API and the Vite
dev middleware from one process on one port, so there is no separate client dev server to
run.

Routes (`server/src/routes/*.ts`) are thin Express routers. They validate input (via
`shared/schemas` Zod schemas and the `validate`/`validateQuery` middleware), call a service
function, and shape the response as `{ data: ... }`. All business logic and SQL lives in
`server/src/services/*.ts`. The client's `apiFetch` helper (`client/src/lib/api.ts`)
unwraps that envelope automatically and throws on non-2xx.

The database is SQLite via `better-sqlite3`, with numbered migration files
(`server/src/db/migrations/NNN_description.sql`) applied in order and tracked in a
`schema_migrations` table. Migrations run automatically on server startup, or standalone
via `npm run db:migrate`. SQLite has no `ALTER COLUMN` or `DROP COLUMN` with constraint
changes, so migrations that reshape a table use a create-new-table, copy-data, drop-old,
rename pattern.

On the client, routes and views are lazy-loaded (React Router plus `Suspense`). Server
state (accounts, transactions, and so on) goes through TanStack Query. Zustand is reserved
for small UI-only global state (toasts, selected account, sync status), and server data
never lives there.

## Data Location

All data is stored in the project-local `.mizan/` directory (`process.cwd()/.mizan`, not
your home directory), which assumes npm scripts always run from the repo root:

```
.mizan/
  mizan.db            SQLite database (accounts, transactions, budgets, goals, holdings...)
  credentials.json    AES-256-GCM encrypted API credentials (SimpleFIN, Coinbase)
  logs/                Structured server logs
```

The encryption key for `credentials.json` is stored in your OS keychain via
`@napi-rs/keyring`, not in a plaintext file. Credentials are never stored or logged in
plaintext.

## Sync Behavior

A full sync (`runFullSync()`) does, in order:

1. Syncs SimpleFIN (bank/brokerage accounts, transactions, and investment holdings) if
   credentials are configured.
2. Syncs Coinbase (crypto account balances, per-coin holdings, and filled trade order
   history) if credentials are configured.
3. Runs recurring-transaction detection.
4. Runs duplicate and transfer-pair integrity checks.
5. Takes a net worth snapshot.
6. Kicks off the background AI review worker asynchronously (does not block the sync
   from completing).

Each external provider call is wrapped in retry-with-backoff (`services/retry.ts`) for
transient network and 5xx failures; a 4xx (bad credentials, say) is not retried. A failure
in one stage, for example recurring detection, does not prevent the other stages from
running, and is reported per-stage rather than failing the whole sync silently.

Progress streams to the client over Server-Sent Events (`GET /api/sync/status`,
consumed by `useSyncStatus`), which invalidates the relevant UI caches when the sync
completes.

## SimpleFIN Setup

SimpleFIN Bridge provides read-only access to thousands of financial institutions for a
small monthly fee (~$1.50/mo). It is a reliable, privacy-respecting integration: no
screen-scraping, no stored bank passwords.

1. Create an account at [bridge.simplefin.org](https://bridge.simplefin.org)
2. Connect your financial institutions through their dashboard.
3. Once connected, generate a new **Setup Token**.
4. In Mizān, go to **Settings → Connections**.
5. Paste your Setup Token and click **Connect**. Mizān securely exchanges this for a
   permanent Access URL, stores it encrypted, and syncs your accounts immediately.

What syncs: account balances, transactions (last 30 days on incremental syncs, up to 2
years of backlog on the very first sync per connection, though institutions may cap what
they actually return), and investment holdings (ticker, shares, market value, cost basis
when the institution provides one) for brokerage and IRA accounts.

## Coinbase Setup

1. Go to [portal.cdp.coinbase.com/projects/api-keys](https://portal.cdp.coinbase.com/projects/api-keys)
2. Create an **Advanced Trade API** key with read permissions.
3. Copy the **Key Name** (e.g. `organizations/xxx/apiKeys/yyy`) and **Private Key** (EC PEM).
4. In Mizān, go to **Settings → Coinbase** and enter your credentials (or set
   `COINBASE_KEY_NAME`/`COINBASE_PRIVATE_KEY` in `.env`, which takes precedence).

What syncs: one crypto wallet account per currency you hold, its USD-valued balance (via
Coinbase's public spot price endpoint), a corresponding holding so each coin shows up
individually in the Investments page, and filled trade order history (buys and sells) as
transactions.

> **Note:** The Advanced Trade API provides balances, holdings, and trade order history.
> Wallet-level transactions (sends, receives, Coinbase Earn rewards) require OAuth, which
> is currently unavailable for new app registrations. This will be added when Coinbase
> re-enables OAuth client creation.
> Track: [portal.cdp.coinbase.com/projects/api-keys/oauth](https://portal.cdp.coinbase.com/projects/api-keys/oauth)

## AI Architecture

Mizān uses three distinct AI surfaces. They are separate code paths with very different
cost, latency, and capability tradeoffs, not different modes of the same thing.

**Local heuristics** (`POST /api/ai/analyze`, `services/advisorTools.ts`) are regex and DB
driven, make no network call, and return in under a millisecond. They power the Cmd+K
command palette and produce the structured citations and one-click "drafts" ("categorize
this transaction", "create this budget") shown in the Advisor chat and Review. This layer
works with **no Anthropic API key at all**.

**Cloud LLM chat** (`POST /api/ai/chat`, `routes/ai.ts`) streams from `claude-sonnet-5`
via SSE with adaptive extended thinking (`thinking: { type: 'adaptive', display: 'summarized' }`)
and `output_config: { effort: 'medium' }`, with the financial context snapshot injected
into the system prompt behind prompt-cache `cache_control`. The Advisor chat calls this
*and* the local heuristic in parallel on every message: the LLM produces the conversational
answer, with visible step-by-step reasoning shown as a collapsible "Thinking…" panel while
it streams, and the heuristic supplies the citations and drafts. If no `ANTHROPIC_API_KEY`
is configured, the chat degrades to heuristic-only answers rather than erroring out.

**The background worker** (`services/aiWorker.ts`, runs after every sync) calls
`claude-haiku-4-5` non-streaming to propose drafts from the latest sync delta, stored in
`advisor_drafts` and surfaced in Review. It requires `ANTHROPIC_API_KEY` and is silently
skipped if unset.

### What the AI does on its own

The boundary is drawn by **domain**, not by a confidence score. `AUTONOMOUS_DRAFT_KINDS`
(`services/advisorDrafts.ts`) holds the two operations the AI applies with no confirmation
step. `categorize_transaction` and `create_merchant_rule` apply on arrival, whether from
the background worker or from a chat tool call, because both are observations about data
that already exists. Everything else (`update_budget`, `update_goal_target`,
`confirm_recurring`, `set_manual_cost_basis`, and the rest) always waits for an explicit
confirm, because those change a target the owner set rather than describing what is
already there.

Every applied action is recorded in `advisor_actions`, and every row it touched records
`category_source`, `category_action_id`, and the category it displaced (migration 041). So
`POST /api/ai/actions/:id/undo` reverts the whole blast radius of an action, including
rows a merchant rule swept in, restoring each row's prior category. Rows edited by hand
since are skipped: a manual edit clears `category_action_id` precisely so an undo cannot
reach back through a human decision.

`services/aiContext.ts`'s `buildFinancialContext()` is the single source of truth for
"what the AI knows about your finances", feeding both the chat system prompt and the
background worker prompt. It renders every figure to the cent: it used to abbreviate
anything over $1,000 (`$2,749.39` became `$2.7k`) while the system prompt told the model
never to fabricate numbers, so the model faithfully reported the abbreviation.

The advisor's aggregate tools (`services/advisorChatTools.ts`) delegate to the same
services the UI renders from, rather than running their own SQL. They used to hand-roll it
and drifted: on identical data the advisor reported $1,695.00 of spending where the Reports
page reported $75.00, because it counted transfers, resolved duplicates, pending rows, and
crypto purchases that Reports excludes. Any new aggregate belongs in the shared service.

## Testing

```bash
npm test                                                    # full suite (node:test)
node --test --import tsx tests/reporting.test.ts            # single file
node --test --import tsx --test-name-pattern="savings" tests/budgetMath.test.ts   # single test by name
```

Tests run directly against `.ts` source via the `tsx` loader, with no build step and no
test framework config. Most test files construct a minimal `:memory:` better-sqlite3 schema
with only the tables and columns a given service needs, and call service functions directly
rather than going through HTTP routes.

There is no lint script. Type-check manually when needed:

```bash
npx tsc --noEmit -p tsconfig.server.json   # server + shared
npx tsc --noEmit -p tsconfig.json          # client + shared
```

## Security

Mizān talks to SimpleFIN, Coinbase, and Anthropic. It syncs on startup and hourly, and the
background AI review runs after each sync, so those calls happen without a click.

Provider credentials are AES-256-GCM encrypted at rest in `.mizan/credentials.json`. The
key lives in the OS keychain via `@napi-rs/keyring`; if the keychain is unavailable the app
falls back to a `0600` key file at `.mizan/mizan.key`.

The app has **no authentication layer**, by design: one owner, one machine. Two things
guard that assumption, and they are about integrity rather than secrecy:

- It binds to loopback (`MIZAN_HOST` to change), so it is not reachable from the LAN.
- `middleware/localGuard.ts` rejects requests with an unrecognized `Host` header
  (DNS-rebinding) and cross-origin state-changing requests (a page you happen to be
  visiting POSTing to `localhost:3001` and mutating your ledger).

If you expose it beyond loopback, anything that can reach the port can read and write your
financial data. Put your own auth in front of it.

Model-authored SQL (`run_sql_query`) executes on a separate SQLite connection opened in
readonly mode, so a write cannot reach the data even if a guard is bypassed. The AI's write
tools go through typed service functions, never raw SQL.

## License

MIT
