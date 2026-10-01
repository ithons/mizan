-- Which hidden accounts a disconnect hid, as opposed to the owner.
--
-- Disconnecting SimpleFIN or Coinbase sets is_hidden = 1 on every account of that provider, and
-- nothing ever set it back: reconnecting brought the balances up to date on accounts that stayed out
-- of net worth and every total until the owner found and unhid each one. On 2026-10-01 that was nine
-- SimpleFIN accounts at once. Restoring "every hidden account of the provider" would also unhide the
-- ones the owner hid on purpose, so the disconnect has to say which ones were its own.
--
-- A sync that sees the account again clears the flag and the hide with it; an owner's own hide or
-- unhide clears the flag and keeps their choice. No backfill: the only rows a disconnect had hidden
-- were unhidden by hand the same night.
ALTER TABLE accounts ADD COLUMN hidden_by_disconnect INTEGER NOT NULL DEFAULT 0
  CHECK (hidden_by_disconnect IN (0, 1));
