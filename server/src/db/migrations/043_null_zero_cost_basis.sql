-- A cost basis of 0 is not a basis of zero. It is the provider declining to tell us.
--
-- SimpleFIN returns cost_basis for a Fidelity position whether or not it actually knows one, and
-- for a money-market sweep it sends 0. simplefin.ts already fell back to shares * purchase_price
-- when the basis came back empty, but when purchase_price was empty too it stored the literal 0,
-- and 0 is indistinguishable downstream from "bought for nothing". Everything that reads the
-- column then agrees on the wrong answer: institution_value - cost_basis makes the entire market
-- value unrealized gain, and cost_basis_quality calls that 'provider', i.e. trustworthy.
--
-- On this database that was two SPAXX rows holding $104.99, a cash sweep whose whole point is
-- that it is worth what was put into it. The Investments header read
--   $2,003 cost basis, up $141.82, 7.1%
-- against a true
--   $2,003 cost basis, up $36.83, 1.8%
-- across the positions that actually have a basis. $104.99 of the $141.82 was face value booked
-- as profit, and the header could not be reconciled against the rows underneath it, because the
-- per-row gain in Investments.tsx already refused a basis <= 0 and showed those two rows blank.
--
-- Only rows the provider zeroed are touched, and only where the owner has not entered a manual
-- basis: a manual figure is a deliberate statement and outranks anything a provider said, so a
-- row carrying one is left exactly as it is. NULL here is the honest value, and the same value
-- the ingest path now writes, so a resync will not undo this.

UPDATE holdings
SET cost_basis = NULL
WHERE cost_basis = 0
  AND manual_cost_basis IS NULL;

-- holdings_history is a daily copy of holdings.cost_basis (snapshot.ts), so every date the sweep
-- was held carries the same false zero. Left alone, the series would jump from 0 to NULL on the
-- day of this migration and read as a basis that was known and then lost.
UPDATE holdings_history
SET cost_basis = NULL
WHERE cost_basis = 0;
