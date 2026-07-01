# Mizān

A local-first personal finance application - self-hosted alternative to Monarch Money.

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
# -> app and API at http://localhost:3001

# Production
npm run build
npm start
# -> http://localhost:3001
```

By default, Mizān does not sync external providers on server startup. Use the in-app
sync controls, or set `MIZAN_AUTO_SYNC_ON_STARTUP=true` if you explicitly want startup
sync.

## Data Location

All data is stored in the project-local `.mizan/` directory:

```
.mizan/
  mizan.db            SQLite database
  credentials.json    AES-256-GCM encrypted API credentials
  logs/               Structured server logs
```

Credentials are encrypted at rest using a key derived from your machine's unique identifier. They are never stored in plaintext.

## SimpleFIN Setup

SimpleFIN Bridge provides read-only access to thousands of financial institutions for a small monthly fee (~$1.50/mo). This is a reliable, privacy-respecting integration.

1. Create an account at [bridge.simplefin.org](https://bridge.simplefin.org)
2. Connect your financial institutions through their dashboard.
3. Once connected, generate a new **Setup Token**.
4. In Mizān, go to **Settings → Connections**.
5. Paste your Setup Token and click **Connect**. Mizān will securely exchange this for a permanent Access URL and sync your accounts.

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

## AI Architecture

Mizān relies on Anthropic's Claude 3.7 Sonnet / 3.5 Haiku to perform background sync reviews and exploratory chat.
- **Local Heuristics (`/api/ai/analyze`):** The Command Palette (Cmd+K) and context generation rely on completely local, regex/DB-based heuristics. They execute in sub-milliseconds without network overhead.
- **Cloud LLM (`/api/ai/chat` & background worker):** Explicit chat queries and asynchronous background sync reviews send structured data context to Anthropic APIs. Data ONLY leaves your machine when explicitly initiating a chat or when sync updates trigger a background review.

## Privacy

No data leaves your machine except for direct API calls to:
- SimpleFIN (transaction syncing)
- Coinbase (balance syncing)
- `api.coinbase.com/v2/prices` (public spot price endpoint, no auth)
- Anthropic (explicit AI chat and background sync reviews)

## License

MIT
