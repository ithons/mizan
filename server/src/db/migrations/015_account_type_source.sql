-- Tracks whether `type`/`is_liability` came from the sync heuristic ('auto') or an
-- explicit user override ('manual'). Sync and the one-time reclassification backfill
-- must only ever touch 'auto' rows so a manual correction is never clobbered.
ALTER TABLE accounts ADD COLUMN type_source TEXT NOT NULL DEFAULT 'auto';

-- Any account that isn't SimpleFIN-classified already has an authoritative type
-- (Coinbase always sets crypto_wallet, manual accounts are user-chosen at creation).
UPDATE accounts SET type_source = 'manual' WHERE connection_type != 'simplefin';
