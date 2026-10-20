# Historical backfill

Imports of transaction and account history from before SimpleFIN's window, each run once
against reviewed statement data. The July 2026 CSV pipeline that first filled this history
(normalize, import, dedup, floor-map, backup) has been run and deleted.

## The core idea: a per-account floor

SimpleFIN/Coinbase only serve recent data and dedup **only** on their own provider IDs.
They have no idea imported rows exist, so overlapping history would silently
duplicate. Instead of overlap+dedup, each account gets a `backfill_floor_date`:

- Manual/imported history covers strictly **below** the floor.
- Providers own everything **at or above** it.

Migration `030` adds the column; `server/src/services/backfillFloor.ts` is the guard,
enforced inside `syncSimplefin` and the Coinbase sync. Nothing in the tree writes the
column any more, so the floors stay at their present values.

## Files

    raw/           # original statements and the reviewed JSON the importers read (git-ignored)

Raw statements hold real financial data, so they never enter git. Keep this directory
backed up separately.

## After any import

    tsx scripts/backfill/rebuild.ts

Refreshes duplicate/transfer integrity, recurring detection and the estimated net-worth
history. It calls `backfillSnapshots` directly and records no reconstruction mark; the
rebuild in Settings > Data, and the next sync, go through `reconcileReconstructedHistory`.

## Scanned BofA checking and savings statements

Paper statements for the two closed BofA accounts, scanned to image-only PDFs. Needs
`brew install poppler tesseract`. The page text, `local.json` (the account holder name and personal merchant names, kept out of git) and `fixes.json` (each OCR correction, with how it
was verified against the page image) live in `raw/bofa-statements/`.

    python3 scripts/backfill/bofa_statements.py --ocr "<checking pdf>" "<savings pdf>"
    tsx scripts/backfill/bofa-statements-import.ts            # dry run, rolled back
    tsx scripts/backfill/bofa-statements-import.ts --commit
    tsx scripts/backfill/rebuild.ts
    tsx scripts/backfill/bofa-statements-import.ts --verify   # any time later

The parser refuses to write unless every statement reconciles to its printed totals; the importer
refuses a second run and re-proves each statement's totals and ending balance from the ledger.
Rows carry `source_detail = 'bofa-statement-scan'`.

## The other importers

Each takes a dry run by default and writes only with `--commit`; the header of each file says
what it reads and what it refuses.

    python3 scripts/backfill/bofa_card_statements.py           # BofA card PDFs -> raw/bofa-card-statements.json
    tsx scripts/backfill/bofa-card-statements-import.ts        # also --verify
    tsx scripts/backfill/coinbase-csv-import.ts
    tsx scripts/backfill/fidelity-statements-import.ts
    tsx scripts/backfill/fidelity-valuations-import.ts
    tsx scripts/backfill/refresh-prices.ts                     # fetches missing daily closes; no dry run
