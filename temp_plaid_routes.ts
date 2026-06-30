import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import {
  PlaidExchangeTokenSchema,
} from '../../../shared/schemas';
import {
  createLinkToken,
  exchangeToken,
  syncItemDetailed,
  syncAllItems,
  createUpdateToken,
} from '../services/plaid';
import { removePlaidItemToken } from '../services/credentials';
import { takeSnapshot } from '../services/snapshot';
import {
  finishSyncRun,
  recordSyncRunItem,
  startSyncRun,
} from '../services/syncHistory';
import { refreshTransactionIntegrity } from '../services/transactionIntegrity';

const router = Router();

function defaultRedirectUri() {
  return \`http://localhost:\${process.env.PORT || '3001'}\`;
}

function normalizeRedirectUri(uri?: string): string {
  const base = uri || defaultRedirectUri();
  try {
    const url = new URL(base);
    if (url.hostname === '127.0.0.1') {
      url.hostname = 'localhost';
      return url.toString().replace(/\/$/, '');
    }
    return base;
  } catch {
    return defaultRedirectUri();
  }
}

// POST /link-token
router.post('/link-token', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const redirectUri = normalizeRedirectUri((req.body as { redirectUri?: string }).redirectUri);
    const linkToken = await createLinkToken(redirectUri);
    res.json({ data: { link_token: linkToken, redirect_uri: redirectUri } });
  } catch (err) {
    next(err);
  }
});
