-- Per-account floor for the one-time manual history backfill.
--
-- Manual/imported history lives strictly BELOW this date; providers (SimpleFIN,
-- Coinbase) own everything at or above it. The sync services skip any served
-- transaction whose date < backfill_floor_date, so no future sync (including a
-- 730-day force resync) can ever re-populate or duplicate the imported history.
-- NULL means "no backfill for this account": providers own its full range.
ALTER TABLE accounts ADD COLUMN backfill_floor_date TEXT;
