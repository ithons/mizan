-- Holdings zeroed is not transactions modified.
--
-- The Coinbase stage reported `staleAccountCount` (the number of holdings it set to quantity 0
-- because the feed stopped reporting them) in `sync_run_items.transactions_modified`. The sync
-- panel and `getSyncRunDetail` read that column as what it is named, so a run that modified no
-- transactions and zeroed eight positions rendered as "8 transactions modified": the more alarming
-- event described as the less alarming one, in a column that already means something else.
--
-- It is worth a column rather than a dropped number. A holding going to zero is either a sale the
-- owner made or a feed that stopped answering, and after migration 057's sibling change in
-- `coinbase.ts` the second case no longer zeroes anything, so a non-zero count here now means a
-- real position left the portfolio. That is a thing the owner should be able to see in the run.
--
-- SimpleFIN leaves it 0: its stale-account pass closes accounts rather than zeroing holdings, and
-- it has always reported that through `transactions_removed`.

ALTER TABLE sync_run_items ADD COLUMN holdings_zeroed INTEGER NOT NULL DEFAULT 0;
