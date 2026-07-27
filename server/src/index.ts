import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { createWriteStream } from 'fs';
import ViteExpress from 'vite-express';

import { runMigrations, closeDb, getDb, MIZAN_DIR } from './db/index';
import { loadCredentials } from './services/credentials';
import { isSyncStale, runFullSync, startSyncScheduler, stopSyncScheduler } from './services/syncManager';
import { autoCategorizeTransactions } from './services/rules';
import { reclassifyAutoAccountTypes } from './services/accountClassification';
import { errorHandler } from './middleware/errorHandler';
import { buildLocalGuardConfig, localOriginGuard } from './middleware/localGuard';

import accountsRouter from './routes/accounts';
import transactionsRouter from './routes/transactions';
import investmentsRouter from './routes/investments';
import categoriesRouter from './routes/categories';
import budgetsRouter from './routes/budgets';
import recurringRouter from './routes/recurring';
import goalsRouter from './routes/goals';
import rulesRouter from './routes/rules';
import insightsRouter from './routes/insights';
import reportsRouter from './routes/reports';
import networthRouter from './routes/networth';
import simplefinRouter from './routes/simplefin';
import coinbaseRouter from './routes/coinbase';
import syncRouter from './routes/sync';
import settingsRouter from './routes/settings';
import healthRouter from './routes/health';
import aiRouter from './routes/ai';

const PORT = parseInt(process.env.PORT || '3001', 10);
const IS_PROD = process.env.NODE_ENV === 'production';
// Single-user local app with no auth layer: bind to loopback so the API (and all the
// financial data behind it) isn't reachable from the LAN by default. Set MIZAN_HOST to
// 0.0.0.0 or a specific interface to deliberately expose it beyond this machine.
const HOST = process.env.MIZAN_HOST || '127.0.0.1';
const HOST_IS_LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

async function main() {
  // 1. Run DB migrations. A failure here is fatal and must be loud: the process exits before the
  // HTTP log stream exists, so without this the only symptom is "every request fails to fetch"
  // with nothing in .mizan/logs/server.log to explain it.
  try {
    runMigrations();
  } catch (err) {
    console.error('[fatal] Database migrations failed — the server cannot start.');
    console.error('[fatal] Your data was not modified; migrations run in a transaction.');
    throw err;
  }

  // Backlog passes for older data (transactions left uncategorized, account types frozen
  // by a weaker classifier). Gated behind a cheap COUNT so a clean DB — the common case
  // after the first boot, and every tsx-watch restart in dev — skips the work entirely.
  const startupDb = getDb();
  try {
    const uncategorized = (startupDb.prepare(
      'SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL'
    ).get() as { n: number }).n;
    if (uncategorized > 0) autoCategorizeTransactions(startupDb);
  } catch (err) {
    console.error('[startup] Auto-categorization backfill failed:', err);
  }

  try {
    const autoTyped = (startupDb.prepare(
      "SELECT COUNT(*) AS n FROM accounts WHERE type_source = 'auto'"
    ).get() as { n: number }).n;
    if (autoTyped > 0) reclassifyAutoAccountTypes(startupDb);
  } catch (err) {
    console.error('[startup] Account type reclassification failed:', err);
  }

  // 2. Load credentials (pre-warm cache). Decryption depends on the OS keychain, which can fail
  // (locked keychain, moved .mizan dir) — surface that clearly rather than dying anonymously.
  try {
    loadCredentials();
  } catch (err) {
    console.error('[fatal] Could not load stored credentials (OS keychain unavailable?).');
    throw err;
  }

  const app = express();

  // Logging to ~/.mizan/logs/
  const logsDir = path.join(MIZAN_DIR, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logStream = createWriteStream(path.join(logsDir, 'server.log'), { flags: 'a' });
  app.use(morgan('combined', { stream: logStream }));
  app.use(morgan('dev'));

  // Security. Helmet's default CSP (script-src 'self') blocks Vite's inline
  // HMR preamble script, so dev mode can never render in a real browser with
  // it on — disable CSP in dev, keep helmet's full defaults in production.
  app.use(helmet(IS_PROD ? undefined : { contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: IS_PROD
        ? (process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : false)
        : [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`],
      credentials: true,
    })
  );

  if (IS_PROD) {
    if (process.env.CORS_ORIGIN) {
      console.log(`[startup] CORS_ORIGIN=${process.env.CORS_ORIGIN} — cross-origin requests allowed. The app has no auth middleware, so anything reachable at this origin can read/write your financial data.`);
    } else {
      console.log('[startup] CORS_ORIGIN not set — cross-origin API requests will be rejected. Fine if this process also serves the client (the default). Set CORS_ORIGIN if the client is hosted elsewhere.');
    }
  }

  app.use(express.json({ limit: '10mb' }));

  // Reject requests with an unrecognized Host (DNS-rebinding defense) or a foreign
  // Origin on writes (local CSRF). Honors deliberate exposure via CORS_ORIGIN /
  // MIZAN_HOST / MIZAN_ALLOWED_HOSTS. Applied to the API surface only.
  const localGuard = buildLocalGuardConfig({
    port: PORT,
    host: HOST,
    hostIsLoopback: HOST_IS_LOOPBACK,
    corsOrigin: process.env.CORS_ORIGIN,
    extraHosts: process.env.MIZAN_ALLOWED_HOSTS,
  });
  app.use('/api', localOriginGuard(localGuard));

  // API routes
  app.use('/api/accounts', accountsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/investments', investmentsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/recurring', recurringRouter);
  app.use('/api/goals', goalsRouter);
  app.use('/api/rules', rulesRouter);
  app.use('/api/insights', insightsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/networth', networthRouter);
  app.use('/api/simplefin', simplefinRouter);
  app.use('/api/coinbase', coinbaseRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/ai', aiRouter);

  // Serve built React app in production
  if (IS_PROD) {
    const clientDist = path.join(__dirname, '../../client');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);

  const announce = () => console.log(`\n  Mizān  →  http://localhost:${PORT}\n`);
  if (IS_PROD && !HOST_IS_LOOPBACK) {
    console.log(`[startup] MIZAN_HOST=${HOST} — binding beyond loopback. The app has no auth middleware, so anything that can reach this host/port can read/write your financial data.`);
  }
  const server = IS_PROD
    ? app.listen(PORT, HOST, announce)
    : ViteExpress.listen(app, PORT, announce);

  // Sync runs on boot and on a timer, both on by default. They used to be opt-in, gated behind
  // env vars whose comments cited "it calls external providers" as the reason. That rationale
  // is retired: this is the owner's own machine talking to the owner's own accounts, and an
  // app that shows stale numbers until you remember to click a button is worse at its job.
  // Both remain switchable for the cases where it genuinely matters (offline, debugging).
  //
  // The staleness gate stays, for a different and still-valid reason: `npm run dev` restarts
  // this whole process on every file save (tsx watch), and without it every save while coding
  // would fire a real SimpleFIN + Coinbase + AI-worker pass.
  //
  // Runs without awaiting so the UI paints immediately.
  const STARTUP_SYNC_STALE_MINUTES = 10;
  if (process.env.MIZAN_AUTO_SYNC_ON_STARTUP !== 'false') {
    setTimeout(() => {
      if (!isSyncStale(getDb(), STARTUP_SYNC_STALE_MINUTES)) {
        console.log(`[startup] Skipping auto-sync: last sync was within ${STARTUP_SYNC_STALE_MINUTES} minutes.`);
        return;
      }
      runFullSync().catch((err) => {
        console.error('[startup] Sync failed:', (err as Error).message);
      });
    }, 2000);
  }

  // Set MIZAN_SYNC_INTERVAL_MINUTES=0 to turn the timer off.
  const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
  const rawInterval = process.env.MIZAN_SYNC_INTERVAL_MINUTES;
  const parsedInterval = rawInterval === undefined ? DEFAULT_SYNC_INTERVAL_MINUTES : parseInt(rawInterval, 10);
  const syncIntervalMinutes = Number.isFinite(parsedInterval) ? parsedInterval : DEFAULT_SYNC_INTERVAL_MINUTES;
  if (syncIntervalMinutes > 0) {
    console.log(`[startup] Periodic sync: every ${syncIntervalMinutes} minute(s). Set MIZAN_SYNC_INTERVAL_MINUTES=0 to disable.`);
    startSyncScheduler(syncIntervalMinutes);
  } else {
    console.log('[startup] Periodic sync disabled (MIZAN_SYNC_INTERVAL_MINUTES=0).');
  }

  // Graceful shutdown. server.close() waits for every open connection, and the client holds a
  // permanent SSE stream (/api/sync/status), so with a browser tab open the callback never fires:
  // Ctrl-C appeared to hang, closeDb() never ran, and the DB was left with a dirty WAL. Force the
  // exit after a short grace period so a clean checkpoint still happens.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[server] Shutting down...');
    stopSyncScheduler();

    const finish = () => {
      try {
        closeDb();
      } catch (err) {
        console.error('[server] Error closing the database:', err);
      }
      process.exit(0);
    };

    const forceExit = setTimeout(() => {
      console.warn('[server] Connections still open (SSE clients) — closing anyway.');
      finish();
    }, 2000);
    forceExit.unref();

    server.close(() => {
      clearTimeout(forceExit);
      finish();
    });
    // Drop keep-alive/SSE sockets so the close callback can actually fire.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
