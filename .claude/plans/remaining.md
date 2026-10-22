# Remaining work

The one plan file. Everything the six earlier plans (`rebuild.md`, `rebuild-part-2.md`,
`rebuild-part-3.md`, `relink-and-close.md`, `ui-overhaul.md`, `part-4-the-last-mile.md` with
`part-4-findings.md`) left open was checked against the code on 2026-10-20; what was done or made
moot is not repeated here. Those files are in git history (`git show 7f498b5:.claude/plans/<file>`)
for the long-form record of why the code is the way it is.

## Code

1. **Colour silence is checked on rendered screens only.** `tests/healthyScreens.test.ts` covers all
   seven screens with panels closed. Settings panels and every modal open through effects that
   server-side rendering does not run, so they are outside the check until a DOM renderer exists.
2. **An uncategorized row is unmarked on the Ledger** while Balance counts it in clay. The Ledger's
   "Needs a category" filter exists; whether the row itself should carry a mark is open.

## Data waiting on the bank feed

3. **Two bounced Fidelity deposits** (Apr 15 and May 15, 2026) are stored by SimpleFIN with both legs
   positive, overstating money put in by $400 and keeping April estimated on the history chart. Left
   as reported by rule; an owner correction through `amount_source` would settle it if the owner asks.
4. **Three FSKAX buys** (Aug 4, 11 and 18, 2026) sit above Fidelity's floor and the feed never
   delivered them. Holdings history covers their value; the rows themselves are missing.

## Owner

5. **Push.** `main` is ahead of GitHub, and history from 02018b5 (Oct 17) was rewritten on
   2026-10-22 to take friends' names and real reference numbers out of test fixtures, so the push
   needs `git push --force-with-lease origin main` from the owner's terminal (the session's
   permission check refuses it). GitHub keeps the old commits fetchable by hash until its support
   purges them.
6. **Cloud backup** of `.mizan/` and `data/`, plus the keychain key that decrypts
   `credentials.json` (`security find-generic-password -s mizan -a encryption_key -w`), which does
   not travel with the folder. Nothing is backed up on this device by choice.
7. **Not app work, recorded so it is not lost:** the missed October Chase Sapphire autopay (call
   about fees, confirm the Nov 10 payment), the IRA limit for the 2026 room estimate, and whether
   BofA's backup withholding means a tax-ID form was never filed.

## Decided, not to build

- Sortable ledger headers and `aria-sort`: the ledger has no column headers to sort.
- The Bone and Signal palette versus pure black and white (Part IV finding 9): a recorded design
  decision.
- `CLAUDE.md` stays gitignored, by the owner's choice.
- Category colour swatches stay literal hexes: a category's colour is stored as a literal value.
- A bank-funded Coinbase buy has no Coinbase deposit to pair with; its bank leg is Transfer Out.
