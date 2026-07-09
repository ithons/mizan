# Mizān

A local-first personal finance application — a self-hosted alternative to Monarch Money.

All data stays on your machine. No telemetry. No subscriptions. No third party ever sees
your data except the specific providers you explicitly connect (SimpleFIN, Coinbase,
Anthropic), and only for the specific calls documented below.

## Features

- **Accounts & transactions** — bank/credit/investment/crypto accounts via SimpleFIN and
  Coinbase, or fully manual accounts. Transaction search, filtering, splitting, and manual
  entry.
- **Review Inbox** — a single queue for everything that needs a decision: uncategorized
  transactions, pending charges, suggested merchant rules, unconfirmed recurring bills,
  duplicate/transfer candidates, and proactive AI insights. Supports single-item and
  batch actions.
- **Budgets** — per-category monthly budgets with rollover, grouped into custom budget
  groups.
- **Goals** — savings goals, including tax-withholding "envelopes" for freelance income.
- **Recurring bills & subscriptions** — automatic detection from transaction history, with
  forecasted upcoming occurrences and one-off skip/snooze/adjust overrides.
- **Investments** — holdings (equities, funds, and crypto) with cost basis, unrealized
  gain/loss, sector/asset-class allocation, and manual cost-basis overrides for providers
  that don't return one.
- **Net worth tracking** — historical snapshots and trend charts across liquid, investment,
  crypto, and liability buckets.
- **AI Advisor** — see [AI Architecture](#ai-architecture) below; a command-palette-style
  instant heuristic layer plus a real conversational LLM chat with full financial context.
- **CSV import** — for accounts not covered by SimpleFIN or Coinbase.

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

`better-sqlite3` is a native module compiled against your Node version — if you switch
Node versions, run `npm rebuild better-sqlite3`.

By default, Mizān never contacts SimpleFIN, Coinbase, or Anthropic on startup or in the
background. Every sync is either a manual click in the UI or an explicit opt-in via the
environment variables below.

## Environment Variables

Copy `.env.example` to `.env` and fill in what you need. `.env` is gitignored — nothing in
it ever leaves your machine except via the specific outbound calls it configures.

| Variable | Required | Purpose |
|---|---|---|
| `COINBASE_KEY_NAME` / `COINBASE_PRIVATE_KEY` | No | Coinbase Advanced Trade API credentials. Optional here — you can instead paste them into **Settings → Coinbase** in the UI, where they're encrypted at rest. Values from `.env` take precedence over stored ones. |
| `ANTHROPIC_API_KEY` | No | Enables the AI Advisor chat (`/api/ai/chat`) and the background AI review worker. Without it, the app runs fully — the local heuristic advisor, command palette, and every other feature work with no key at all. |
| `CORS_ORIGIN` | No, production only | Only needed if the client is hosted at a different origin than this server. The default single-process deployment doesn't need it. The app has no auth layer, so anything reachable at this origin can read/write your financial data — only set it to an origin you control. |
| `MIZAN_AUTO_SYNC_ON_STARTUP` | No | Set to `true` to run a full sync automatically ~2s after the server starts. Off by default. |
| `MIZAN_SYNC_INTERVAL_MINUTES` | No | Set to a positive integer to run a full sync automatically on that interval while the server is running, in addition to (or instead of) manual/startup sync. Off by default. |
| `PORT` | No | Server port. Defaults to `3001`. |

## Architecture

**Stack:** Express + better-sqlite3 on the server, React + Vite + TanStack Query + Zustand
on the client, shared Zod schemas and TypeScript types in `shared/`. In development,
[`vite-express`](https://github.com/szymmis/vite-express) serves both the API and the Vite
dev middleware from one process on one port — there's no separate client dev server to
run.

**Route → service split:** routes (`server/src/routes/*.ts`) are thin Express routers —
they validate input (via `shared/schemas` Zod schemas and the `validate`/`validateQuery`
middleware), call a service function, and shape the response as `{ data: ... }`. All
business logic and SQL lives in `server/src/services/*.ts`. The client's `apiFetch` helper
(`client/src/lib/api.ts`) unwraps that envelope automatically and throws on non-2xx.

**Database:** SQLite via `better-sqlite3`, with numbered migration files
(`server/src/db/migrations/NNN_description.sql`) applied in order and tracked in a
`schema_migrations` table. Migrations run automatically on server startup, or standalone
via `npm run db:migrate`. SQLite has no `ALTER COLUMN`/`DROP COLUMN` with constraint
changes, so migrations that reshape a table use a create-new-table/copy-data/drop-old/
rename pattern.

**Client:** routes/views are lazy-loaded (React Router + `Suspense`). Server state
(accounts, transactions, etc.) goes through TanStack Query; Zustand is reserved for
small UI-only global state (toasts, selected account, sync status) — server data never
lives there.

## Data Location

All data is stored in the project-local `.mizan/` directory (`process.cwd()/.mizan`, not
your home directory) — this assumes npm scripts always run from the repo root:

```
.mizan/
  mizan.db            SQLite database (accounts, transactions, budgets, goals, holdings...)
  credentials.json    AES-256-GCM encrypted API credentials (SimpleFIN, Coinbase)
  logs/                Structured server logs
```

The encryption key for `credentials.json` is stored in your OS keychain via
`@napi-rs/keyring` (not in a plaintext file). Credentials are never stored or logged in
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
transient network/5xx failures; a 4xx (bad credentials, etc.) is not retried. A failure in
one stage (e.g. recurring detection) does not prevent the other stages from running, and
is reported per-stage rather than failing the whole sync silently.

Progress streams to the client over Server-Sent Events (`GET /api/sync/status`,
consumed by `useSyncStatus`), which invalidates the relevant UI caches when the sync
completes.

## SimpleFIN Setup

SimpleFIN Bridge provides read-only access to thousands of financial institutions for a
small monthly fee (~$1.50/mo). This is a reliable, privacy-respecting integration — no
screen-scraping, no stored bank passwords.

1. Create an account at [bridge.simplefin.org](https://bridge.simplefin.org)
2. Connect your financial institutions through their dashboard.
3. Once connected, generate a new **Setup Token**.
4. In Mizān, go to **Settings → Connections**.
5. Paste your Setup Token and click **Connect**. Mizān securely exchanges this for a
   permanent Access URL, stores it encrypted, and syncs your accounts immediately.

What syncs: account balances, transactions (last 30 days on incremental syncs, up to 2
years of backlog on the very first sync per connection — institutions may cap what they
actually return), and investment holdings (ticker, shares, market value, cost basis when
the institution provides one) for brokerage/IRA accounts.

## Coinbase Setup

1. Go to [portal.cdp.coinbase.com/projects/api-keys](https://portal.cdp.coinbase.com/projects/api-keys)
2. Create an **Advanced Trade API** key with read permissions.
3. Copy the **Key Name** (e.g. `organizations/xxx/apiKeys/yyy`) and **Private Key** (EC PEM).
4. In Mizān, go to **Settings → Coinbase** and enter your credentials (or set
   `COINBASE_KEY_NAME`/`COINBASE_PRIVATE_KEY` in `.env`, which takes precedence).

What syncs: one crypto wallet account per currency you hold, its USD-valued balance (via
Coinbase's public spot price endpoint), a corresponding holding so each coin shows up
individually in the Investments page, and filled trade order history (buys/sells) as
transactions.

> **Note:** The Advanced Trade API provides balances, holdings, and trade order history.
> Wallet-level transactions (sends, receives, Coinbase Earn rewards) require OAuth, which
> is currently unavailable for new app registrations. This will be added when Coinbase
> re-enables OAuth client creation.
> Track: [portal.cdp.coinbase.com/projects/api-keys/oauth](https://portal.cdp.coinbase.com/projects/api-keys/oauth)

## AI Architecture

Mizān uses three distinct AI surfaces — they're separate code paths with very different
cost/latency/capability tradeoffs, not different modes of the same thing:

- **Local heuristics** (`POST /api/ai/analyze`, `services/advisorTools.ts`) — regex/DB-driven,
  no network call, sub-millisecond. Powers the Cmd+K command palette and produces the
  structured citations/one-click "drafts" (e.g. "categorize this transaction",
  "create this budget") shown in the Advisor chat and Review Inbox. Works with **no
  Anthropic API key at all**.
- **Cloud LLM chat** (`POST /api/ai/chat`, `routes/ai.ts`) — streams from `claude-sonnet-5`
  via SSE with adaptive extended thinking (`thinking: { type: 'adaptive', display: 'summarized' }`)
  and `output_config: { effort: 'medium' }`, with the financial context snapshot injected
  into the system prompt behind prompt-cache `cache_control`. The Advisor chat calls this
  *and* the local heuristic in parallel on every message — the LLM produces the
  conversational answer (with visible step-by-step reasoning shown as a collapsible
  "Thinking…" panel while it streams), the heuristic supplies the citations/drafts. If no
  `ANTHROPIC_API_KEY` is configured, the chat degrades to heuristic-only answers rather
  than erroring out. Requires `ANTHROPIC_API_KEY`.
- **Background worker** (`services/aiWorker.ts`, runs after every sync) — calls
  `claude-haiku-4-5` (non-streaming) to propose actionable "drafts" from the latest sync
  delta (categorize a transaction, create a merchant rule, adjust a recurring occurrence,
  allocate freelance income to a tax-withholding goal, etc.), stored in `advisor_drafts`
  and surfaced in the Review Inbox. High-confidence categorization/rule drafts (≥ 90%
  confidence, as self-reported by the model) auto-apply; everything else waits for a
  one-click confirm or dismiss. Requires `ANTHROPIC_API_KEY`; silently skipped if unset.

`services/aiContext.ts`'s `buildFinancialContext()` is the single source of truth for
"what the AI knows about your finances" — the same function feeds the chat system prompt,
the background worker prompt, and the UI's context preview panel, so all three see a
consistent snapshot.

## Testing

```bash
npm test                                                    # full suite (node:test)
node --test --import tsx tests/reporting.test.ts            # single file
node --test --import tsx --test-name-pattern="savings" tests/budgetMath.test.ts   # single test by name
```

Tests run directly against `.ts` source via the `tsx` loader — no build step, no test
framework config. Most test files construct a minimal `:memory:` better-sqlite3 schema
with only the tables/columns a given service needs, and call service functions directly
rather than going through HTTP routes.

There is no lint script. Type-check manually when needed:

```bash
npx tsc --noEmit -p tsconfig.server.json   # server + shared
npx tsc --noEmit -p tsconfig.json          # client + shared
```

## Privacy & Security

No data leaves your machine except for direct API calls to:
- **SimpleFIN** — transaction/balance/holdings syncing (only when you sync).
- **Coinbase** — balance/holdings/trade-history syncing (only when you sync).
- **`api.coinbase.com/v2/prices`** — public spot price endpoint, no auth, no account data sent.
- **Anthropic** — only for explicit Advisor chat messages and the post-sync background
  review; only if `ANTHROPIC_API_KEY` is set.

Credentials are AES-256-GCM encrypted at rest (`.mizan/credentials.json`), with the
encryption key held in your OS keychain rather than on disk. The app itself has **no
authentication layer** — it's designed to run on `localhost` or a network you already
trust. If you expose it beyond that (e.g. set `CORS_ORIGIN` in production), anything
reachable at that origin can read and write your financial data; put your own auth in
front of it if you do this.

## License

MIT
