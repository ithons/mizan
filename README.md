# Mizān

A local-first personal finance application — self-hosted alternative to Monarch Money.

All data stays on your machine. No telemetry. No subscriptions.

## Prerequisites

- Node.js 20+
- npm

## Install & Run

```bash
git clone <repo-url> mizan
cd mizan
npm install

# Development (hot reload)
npm run dev
# → frontend at http://localhost:3000
# → API at http://localhost:3001

# Production
npm run build
npm start
# → http://localhost:3001
```

## Data Location

All data is stored in `~/.mizan/`:

```
~/.mizan/
  mizan.db            SQLite database
  credentials.json    AES-256-GCM encrypted API credentials
  logs/               Structured server logs
```

Credentials are encrypted at rest using a key derived from your machine's unique identifier. They are never stored in plaintext.

## Plaid Setup

1. Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com)
2. Go to **Team Settings → API** and copy your **Client ID** and **Sandbox Secret**
3. Ensure **Transactions** and **Investments** products are enabled
4. In Mizān, go to **Settings → Plaid** and enter your credentials
5. Click **Connect Bank or Card** to link an account via Plaid Link
6. In sandbox, use `user_good` / `pass_good` to test

### OAuth institutions (Chase, Wells Fargo, Bank of America, etc.)

Some banks use OAuth — instead of entering credentials inside Plaid Link, the browser
navigates to the bank's website and back. **This will not work until you register the
redirect URI in your Plaid dashboard.** Symptoms of a missing registration: you land on
the bank login page but never return to the app; or you see `plaid-link-oauth://handoff`
in the URL state.

**Required one-time setup:**

1. Go to [dashboard.plaid.com](https://dashboard.plaid.com) → **Team Settings → API → Allowed redirect URIs**
2. Click **Add URI** and enter exactly: `http://localhost:3000`
3. Save

Without step 2, Plaid embeds `plaid-link-oauth://handoff` (a mobile deep-link scheme) in
the OAuth state instead of your localhost URL, and the browser cannot handle it.

In production, replace `http://localhost:3000` with your actual domain.

## Coinbase Setup

1. Go to [portal.cdp.coinbase.com/projects/api-keys](https://portal.cdp.coinbase.com/projects/api-keys)
2. Create an **Advanced Trade API** key with read permissions
3. Copy the **Key Name** (e.g. `organizations/xxx/apiKeys/yyy`) and **Private Key** (EC PEM)
4. In Mizān, go to **Settings → Coinbase** and enter your credentials

> **Note:** The Advanced Trade API provides crypto balances and trade order history.
> Wallet-level transactions (sends, receives, Coinbase Earn rewards) require OAuth,
> which is currently unavailable for new app registrations. This will be added when
> Coinbase re-enables OAuth client creation.
> Track: [portal.cdp.coinbase.com/projects/api-keys/oauth](https://portal.cdp.coinbase.com/projects/api-keys/oauth)

## Privacy

No data leaves your machine except for direct API calls to:
- Plaid (transaction syncing)
- Coinbase (balance syncing)
- `api.coinbase.com/v2/prices` (public spot price endpoint, no auth)

## License

MIT
