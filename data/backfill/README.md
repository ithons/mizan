# Historical backfill

One-time, durable import of transaction + account history from before SimpleFIN's
window. Designed to be run once and never repeated.

## The core idea: a per-account floor

SimpleFIN/Coinbase only serve recent data and dedup **only** on their own provider IDs.
They have no idea imported rows exist, so overlapping history would silently
duplicate. Instead of overlap+dedup, each account gets a `backfill_floor_date`:

- Manual/imported history covers strictly **below** the floor.
- Providers own everything **at or above** it.

Migration `030` adds the column; `server/src/services/backfillFloor.ts` is the guard,
enforced inside `syncSimplefin` and the Coinbase sync. Once the floor is set, **no
future sync (including a 730-day force resync) can reach into or duplicate the
imported zone.** That is what makes this last indefinitely.

## Files (all git-ignored except this README + jobs.example.json)

    raw/           # your original bank/brokerage exports (CSV/OFX/PDF): the source of truth
    normalized/    # canonical CSVs produced by normalize.ts, one per account, for review
    backups/       # localBackup JSON snapshots written by backup.ts
    floors.json    # per-account floor map (floor-map.ts): review/edit before --apply
    jobs.json      # your real normalize jobs (copy from jobs.example.json)

Raw statements and backups hold real financial data, so they never enter git. Keep
this directory backed up separately; together with the committed scripts it makes the
whole backfill reproducible.

## Run order

    # 1. Inventory accounts + oldest provider date → floors.json (review it)
    tsx scripts/backfill/floor-map.ts

    # 2. Arm the permanent guard (writes backfill_floor_date from floors.json)
    tsx scripts/backfill/floor-map.ts --apply

    # 3. Put raw exports in raw/, write jobs.json, then normalize → normalized/*.csv
    tsx scripts/backfill/normalize.ts        # drops anything at/above each floor

    # 4. Import (dry run first, then commit)
    tsx scripts/backfill/import.ts
    tsx scripts/backfill/import.ts --commit

    # 5. Remove any intra-import duplicates (overlapping statement periods)
    tsx scripts/backfill/dedup.ts
    tsx scripts/backfill/dedup.ts --commit

    # 6. Rebuild derived data (integrity, recurring, deep net-worth history)
    tsx scripts/backfill/rebuild.ts

    # 7. Capture the durability snapshot
    tsx scripts/backfill/backup.ts

## Adding a format

`normalize.ts` ships a `generic-csv` adapter (single signed amount column, or
debit/credit pair). For OFX/QFX or bank-specific PDF layouts, add an entry to the
`ADAPTERS` registry in `normalize.ts` that returns canonical rows; everything
downstream is format-agnostic.

## Manual (cash) accounts: decide before importing

Importing into a **manual** account moves its `current_balance` (provider accounts are
untouched). Either set the manual account's true present balance and import history so
it reconciles, or import first and correct the balance after. Provider accounts need no
such care.
