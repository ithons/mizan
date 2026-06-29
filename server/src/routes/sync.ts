import { Router, Request, Response, NextFunction } from 'express';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { getDb } from '../db/index';
import { addSseClient, removeSseClient, runFullSync } from '../services/syncManager';
import type { SyncHealth, SyncHealthConnection, SyncHealthStatus } from '../../../shared/types';

const router = Router();

interface ConnectionRow {
  id: string;
  provider: 'plaid' | 'coinbase';
  institution_name: string | null;
  status: string;
  last_synced_at: string | null;
  account_count: number;
}

function ageInDays(iso: string | null): number | null {
  if (!iso) return null;

  const parsed = parseISO(iso);
  if (Number.isNaN(parsed.getTime())) return null;

  return differenceInCalendarDays(new Date(), parsed);
}

function toConnection(row: ConnectionRow): SyncHealthConnection {
  const stale = row.status === 'active' && ((ageInDays(row.last_synced_at) ?? 999) >= 3);
  const needsAttention = row.status !== 'active';

  return {
    id: row.id,
    provider: row.provider,
    institution_name: row.institution_name || (row.provider === 'plaid' ? 'Bank connection' : 'Coinbase'),
    status: row.status,
    last_synced_at: row.last_synced_at,
    account_count: row.account_count,
    is_stale: stale,
    needs_attention: needsAttention,
  };
}

function summarize(connections: SyncHealthConnection[]): SyncHealth {
  const staleCount = connections.filter((connection) => connection.is_stale).length;
  const attentionCount = connections.filter((connection) => connection.needs_attention).length;
  const syncedDates = connections
    .map((connection) => connection.last_synced_at)
    .filter((date): date is string => Boolean(date))
    .sort();

  let status: SyncHealthStatus = 'healthy';
  if (connections.length === 0) {
    status = 'empty';
  } else if (attentionCount > 0) {
    status = 'attention';
  } else if (staleCount > 0) {
    status = 'stale';
  }

  return {
    status,
    connection_count: connections.length,
    stale_count: staleCount,
    attention_count: attentionCount,
    last_synced_at: syncedDates.at(-1) ?? null,
    connections,
  };
}

router.post('/run', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await runFullSync();
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/health', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const plaidRows = db.prepare(`
      SELECT
        pi.id,
        'plaid' AS provider,
        pi.institution_name,
        pi.status,
        pi.last_synced_at,
        COUNT(a.id) AS account_count
      FROM plaid_items pi
      LEFT JOIN accounts a
        ON a.connection_id = pi.id
       AND a.connection_type = 'plaid'
       AND a.is_hidden = 0
      WHERE pi.status != 'removed'
      GROUP BY pi.id
    `).all() as ConnectionRow[];

    const coinbaseRows = db.prepare(`
      SELECT
        cc.id,
        'coinbase' AS provider,
        cc.display_name AS institution_name,
        cc.status,
        cc.last_synced_at,
        COUNT(a.id) AS account_count
      FROM coinbase_connections cc
      LEFT JOIN accounts a
        ON a.connection_id = cc.id
       AND a.connection_type = 'coinbase'
       AND a.is_hidden = 0
      WHERE cc.status != 'disconnected'
      GROUP BY cc.id
    `).all() as ConnectionRow[];

    const connections = [...plaidRows, ...coinbaseRows].map(toConnection);
    res.json({ data: summarize(connections) });
  } catch (err) {
    next(err);
  }
});

// GET /status - SSE endpoint
router.get('/status', (req: Request, res: Response): void => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Flush headers immediately
  res.flushHeaders();

  // Send initial keepalive comment
  res.write(': keepalive\n\n');

  addSseClient(res);

  // Send periodic keepalive to prevent proxy timeouts
  const keepaliveInterval = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepaliveInterval);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepaliveInterval);
    removeSseClient(res);
  });
});

export default router;
