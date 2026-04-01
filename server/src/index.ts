import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { createWriteStream } from 'fs';

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
import reportsRouter from './routes/reports';
import networthRouter from './routes/networth';
import plaidRouter from './routes/plaid';
import coinbaseRouter from './routes/coinbase';
import syncRouter from './routes/sync';
import settingsRouter from './routes/settings';
import healthRouter from './routes/health';

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
  app.use(
    helmet({
      contentSecurityPolicy: false, // Allow Plaid CDN script
    })
  );
  app.use(
    cors({
      origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
      credentials: true,
    })
  );

  app.use(express.json({ limit: '10mb' }));

  // API routes
  app.use('/api/accounts', accountsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/investments', investmentsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/recurring', recurringRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/networth', networthRouter);
  app.use('/api/plaid', plaidRouter);
  app.use('/api/coinbase', coinbaseRouter);
  app.use('/api/sync/status', syncRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/health', healthRouter);

  // Serve built React app in production
  if (IS_PROD) {
    const clientDist = path.join(__dirname, '../../client');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Mizān  →  http://localhost:${PORT}\n`);
  });

  // 3. Background sync on startup (non-blocking)
  setTimeout(async () => {
    try {
      await runFullSync();
    } catch (err) {
      console.error('[startup] Sync failed:', (err as Error).message);
    }
  }, 2000);

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
