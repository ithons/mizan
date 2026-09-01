-- An instrument whose class nobody stated is NULL, not 'equity'.
--
-- `securities.type` was NOT NULL with a CHECK over six classes, and the only provider that
-- introduces securities (SimpleFIN) hands over ticker, name and currency and nothing about what
-- kind of instrument it is. `upsertHoldingsFromSimplefin` therefore hardcoded 'equity' for every
-- new security. On the live ledger that made a government money-market sweep (SPAXX) and two index
-- funds all read "Equity" on the Investments allocation lens, the lens the screen opens on, and
-- nothing anywhere recorded that the value was a default rather than a fact.
--
-- 'other' was not an honest substitute: `investmentAnalytics.ts` treats `security_type = 'other'`
-- as a real asset class with its own fold, so writing it for "unknown" would have conflated the
-- two the way an empty credentials store and an unreadable one used to be conflated. NULL is what
-- the column means when nobody has said, and the lens already labels NULL "Unclassified".
--
-- SQLite cannot alter a CHECK in place, so this is the create-copy-drop-rename pattern from 014.
-- `runMigrationsOn` turns foreign keys off for the duration; the three tables that reference
-- `securities` (transactions, holdings, holdings_history) do so by name, which the rename keeps.
--
-- Existing rows are left as they are, including the three SimpleFIN rows written as 'equity' by
-- the old code. Rewriting them would be repairing data instead of the write path; the owner can
-- now set the class through PUT /api/investments/securities/:id/metadata, recorded the way a
-- sector is.

CREATE TABLE securities_new (
  id TEXT PRIMARY KEY,
  ticker TEXT,
  name TEXT NOT NULL,
  type TEXT CHECK(type IS NULL OR type IN ('equity','etf','mutual_fund','crypto','cash','other')),
  currency TEXT NOT NULL DEFAULT 'USD',
  sector TEXT,
  sector_source TEXT
);

INSERT INTO securities_new (id, ticker, name, type, currency, sector, sector_source)
SELECT id, ticker, name, type, currency, sector, sector_source FROM securities;

DROP TABLE securities;
ALTER TABLE securities_new RENAME TO securities;
