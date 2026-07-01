import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { createWriteStream } from 'fs';
import ViteExpress from 'vite-express';

import { runMigrations, closeDb, MIZAN_DIR } from './db/index';
import { loadCredentials } from './services/credentials';
import { runFullSync } from './services/syncManager';
import { errorHandler } from './middleware/errorHandler';

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

async function main() {
  // 1. Run DB migrations
  runMigrations();

  // 2. Load credentials (pre-warm cache)
  loadCredentials();

  const app = express();

  // Logging to ~/.mizan/logs/
  const logsDir = path.join(MIZAN_DIR, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logStream = createWriteStream(path.join(logsDir, 'server.log'), { flags: 'a' });
  app.use(morgan('combined', { stream: logStream }));
  app.use(morgan('dev'));

  // Security
  app.use(helmet());
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
  const server = IS_PROD
    ? app.listen(PORT, '0.0.0.0', announce)
    : ViteExpress.listen(app, PORT, announce);

  // Startup sync is opt-in because it calls external providers.
  // It intentionally runs asynchronously without awaiting so the UI can paint immediately.
  if (process.env.MIZAN_AUTO_SYNC_ON_STARTUP === 'true') {
    setTimeout(() => {
      runFullSync().catch((err) => {
        console.error('[startup] Sync failed:', (err as Error).message);
      });
    }, 2000);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[server] Shutting down...');
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
