import { Router, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  SimplefinCredentialsSchema,
  SimplefinRelinkAdoptSchema,
  SimplefinRelinkDismissSchema,
} from '../../../shared/schemas';
import type {
  SimplefinRelinkAdoptRequest,
  SimplefinRelinkAdoptResponse,
  SimplefinRelinkDismissRequest,
  SimplefinRelinkDismissResponse,
  SimplefinRelinkPendingResponse,
  SimplefinRelinkStoredCarryView,
} from '../../../shared/types';
import { updateSimplefin, removeSimplefin } from '../services/credentials';
import {
  adoptRelinkPairs,
  dismissRelinkProposal,
  getPendingRelinkProposal,
  getRelinkProposal,
  toRelinkProposalView,
  type AdoptRelinkRefusal,
  type SimplefinRelinkProposal,
} from '../services/simplefinRelink';
import { runFullSync, isSyncActive } from '../services/syncManager';
import { listSyncRuns } from '../services/syncHistory';
import axios from 'axios';
import { PROVIDER_HTTP_TIMEOUT_MS } from '../services/httpTimeouts';

const router = Router();

// POST /setup
router.post(
  '/setup',
  validate(SimplefinCredentialsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { setupToken } = req.body as { setupToken: string };

      // Decode the base64 setup token to get the claim URL
      const decoded = Buffer.from(setupToken, 'base64').toString('utf-8');
      const accessUrl = await axios
        .post(decoded, undefined, { timeout: PROVIDER_HTTP_TIMEOUT_MS })
        .then((r) => r.data as string);

      // The access URL (which embeds basic-auth) is persisted only in the encrypted
      // credentials store, never in the DB. The connection row is a non-secret marker.
      updateSimplefin(accessUrl);

      const db = getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO simplefin_connections (id, status, created_at)
         VALUES ('simplefin_primary', 'active', ?)
         ON CONFLICT(id) DO UPDATE SET status = 'active'`
      ).run(now);

      res.json({ data: { success: true } });

      // Kick off a sync immediately so the user sees real data right after connecting,
      // instead of an empty app until they separately find and click "Sync now".
      // Fire-and-forget: the connection itself is already valid at this point, so a
      // transient sync failure shouldn't fail the setup response the client already got.
      runFullSync().catch((err) => {
        console.error('[simplefin] Post-setup sync failed:', (err as Error).message);
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /connection
router.get('/connection', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const item = db.prepare(
      "SELECT id, status, last_synced_at, created_at FROM simplefin_connections WHERE status != 'removed' LIMIT 1"
    ).get();

    res.json({ data: item || null });
  } catch (err) {
    next(err);
  }
});

// POST /resync: force a fresh 730-day lookback by nulling last_synced_at, then sync.
router.post('/resync', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const db = getDb();
    const connection = db.prepare(
      "SELECT id FROM simplefin_connections WHERE status = 'active' LIMIT 1"
    ).get() as { id: string } | undefined;

    if (!connection) {
      res.status(404).json({ error: 'No active SimpleFIN connection to resync' });
      return;
    }

    if (isSyncActive()) {
      res.status(409).json({ error: 'A sync is already running. Try again in a moment.' });
      return;
    }

    db.prepare("UPDATE simplefin_connections SET last_synced_at = NULL WHERE status = 'active'").run();
    await runFullSync();

    // Read the SimpleFIN-specific item, not the run's overall totals. The run total
    // also sums in unrelated stages (auto-categorization, Coinbase) that would make the
    // "N new transactions" toast misleading about what the deep pull itself found.
    const [latestRun] = listSyncRuns(db, 1);
    const simplefinItem = latestRun
      ? (db.prepare(
          "SELECT transactions_added, transactions_modified FROM sync_run_items WHERE run_id = ? AND connection_id = 'simplefin_primary'"
        ).get(latestRun.id) as { transactions_added: number; transactions_modified: number } | undefined)
      : undefined;

    res.json({
      data: {
        success: true,
        transactionsAdded: simplefinItem?.transactions_added ?? 0,
        transactionsModified: simplefinItem?.transactions_modified ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /connection
router.delete('/connection', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
      "UPDATE accounts SET is_hidden = 1, updated_at = ? WHERE connection_type = 'simplefin'"
    ).run(now);

    removeSimplefin();

    db.prepare(
      "UPDATE simplefin_connections SET status = 'removed'"
    ).run();

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// ─── Re-link ─────────────────────────────────────────────────────────────────
//
// The surface the owner settles a re-minted provider id on. All of the judgement lives in
// `services/simplefinRelink.ts`; this router parses, reads, and shapes.

/**
 * What each stored account the proposal names is carrying right now.
 *
 * Read live rather than lifted out of the proposal's snapshot, because what these columns hold is
 * what adoption exists to preserve, and the owner is confirming against the row as it stands today.
 * A pure read: safe from a GET, which this repo's `localGuard` exempts from the origin check.
 *
 * An account id the proposal names that is no longer in `accounts` yields no row here at all. The
 * screen reads that absence as "no longer in this ledger" rather than rendering a zero count, and
 * `adoptRelinkPairs` refuses such an id at write time regardless of what this returned.
 */
function readStoredCarries(
  db: Database.Database,
  proposal: SimplefinRelinkProposal
): SimplefinRelinkStoredCarryView[] {
  const ids = [
    ...new Set([
      ...proposal.pairs.map((p) => p.storedAccountId),
      ...proposal.unpairedStored.map((u) => u.accountId),
    ]),
  ];
  if (ids.length === 0) return [];

  const rows = db.prepare(`
    SELECT a.id AS account_id,
           a.backfill_floor_date,
           a.type_source,
           a.name_source,
           COUNT(t.id) AS transaction_count,
           MIN(t.date) AS first_transaction_date
    FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.id
    WHERE a.id IN (${ids.map(() => '?').join(', ')})
    GROUP BY a.id
  `).all(...ids) as Array<{
    account_id: string;
    backfill_floor_date: string | null;
    type_source: string;
    name_source: string;
    transaction_count: number;
    first_transaction_date: string | null;
  }>;

  return rows.map((r) => ({
    account_id: r.account_id,
    transaction_count: r.transaction_count,
    first_transaction_date: r.first_transaction_date,
    backfill_floor_date: r.backfill_floor_date,
    type_source: r.type_source,
    name_source: r.name_source,
  }));
}

/** Express widens a path param to `string | string[]`; the repeated-key form is not a proposal id. */
function routeId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? '';
}

function pendingResponse(db: Database.Database): SimplefinRelinkPendingResponse {
  const proposal = getPendingRelinkProposal(db);
  if (!proposal) return { proposal: null, carries: [] };
  return { proposal: toRelinkProposalView(proposal), carries: readStoredCarries(db, proposal) };
}

// GET /relink: the pending proposal with its suggested pairing, or nulls.
//
// Null is the healthy answer, not an error, and it is the answer on every install that has never
// seen a re-link. The client renders nothing at all for it.
router.get('/relink', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: pendingResponse(getDb()) });
  } catch (err) {
    next(err);
  }
});

/**
 * Total over the refusal union, so a refusal added to the service without a status here is a
 * compile error rather than something that falls through to a generic 500 and tells the owner
 * nothing about which half of the mapping it objected to.
 */
const ADOPT_REFUSAL_STATUS: Readonly<Record<AdoptRelinkRefusal, number>> = {
  proposal_not_found: 404,
  // Already applied or dismissed. The request was well formed and arrived too late, which is a
  // conflict with the current state rather than a malformed body.
  proposal_not_pending: 409,
  unknown_stored_account: 422,
  stored_account_not_simplefin: 422,
  provider_account_not_in_snapshot: 422,
  duplicate_stored_account: 422,
  duplicate_provider_account: 422,
  // Another row already holds the requested provider id. Refused whole, never taken.
  contested_provider_id: 409,
};

// POST /relink/:id/adopt: move the confirmed provider ids onto the existing rows.
router.post(
  '/relink/:id/adopt',
  validate(SimplefinRelinkAdoptSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as SimplefinRelinkAdoptRequest;
      const result = adoptRelinkPairs(
        db,
        routeId(req.params.id),
        body.pairs.map((p) => ({
          storedAccountId: p.stored_account_id,
          providerAccountId: p.provider_account_id,
        })),
        new Date().toISOString()
      );

      if (!result.ok) {
        res.status(ADOPT_REFUSAL_STATUS[result.reason]).json({
          error: result.message,
          reason: result.reason,
          details: result.details,
        });
        return;
      }

      // Re-read rather than reshape what was passed in: the response describes the proposal row as
      // it now stands, including the resolution the write just recorded.
      const settled = getRelinkProposal(db, result.proposalId);
      if (!settled) throw new Error(`Adopted proposal ${result.proposalId} could not be re-read`);

      const data: SimplefinRelinkAdoptResponse = {
        proposal: toRelinkProposalView(settled),
        adopted: result.adoptions.map((a) => ({
          stored_account_id: a.storedAccountId,
          provider_account_id: a.providerAccountId,
          previous_simplefin_account_id: a.previousSimplefinAccountId,
          outcome: a.outcome,
        })),
        left_unpaired_stored_account_ids: result.leftUnpairedStoredAccountIds,
        left_unpaired_provider_account_ids: result.leftUnpairedProviderAccountIds,
      };
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /relink/:id/dismiss: the owner's answer that these really are new accounts.
router.post(
  '/relink/:id/dismiss',
  validate(SimplefinRelinkDismissSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { reason } = req.body as SimplefinRelinkDismissRequest;
      const result = dismissRelinkProposal(db, routeId(req.params.id), reason, new Date().toISOString());

      if (!result.ok) {
        res.status(result.reason === 'proposal_not_found' ? 404 : 409).json({
          error: result.message,
          reason: result.reason,
        });
        return;
      }

      const settled = getRelinkProposal(db, result.proposalId);
      if (!settled) throw new Error(`Dismissed proposal ${result.proposalId} could not be re-read`);

      const data: SimplefinRelinkDismissResponse = {
        proposal: toRelinkProposalView(settled),
        acknowledged_provider_ids: result.acknowledgedProviderIds,
      };
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
