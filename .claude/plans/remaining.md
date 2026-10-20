# Remaining work

The one plan file. Everything the six earlier plans (`rebuild.md`, `rebuild-part-2.md`,
`rebuild-part-3.md`, `relink-and-close.md`, `ui-overhaul.md`, `part-4-the-last-mile.md` with
`part-4-findings.md`) left open was checked against the code on 2026-10-20; what was done or made
moot is not repeated here. Those files are in git history (`git show 7f498b5:.claude/plans/<file>`)
for the long-form record of why the code is the way it is.

## Code

1. **Healthy-colour render covers one screen of seven.** `tests/healthyColour.test.ts` renders only
   Balance and says five screens are unverified. Extend it to Ledger, Accounts, Investments, Plan,
   Advisor and Settings on a healthy fixture, asserting no alarm colour where nothing is wrong. The
   2026-09-03 pass on the rest was manual.
2. **Dead estimate branches.** Measured sheets are the only rows `net_worth_snapshots` holds now, but
   `is_estimated` survives as a column and as `isEstimated` in `BalanceScale.tsx` (102, 116, 160,
   190) and `Instrument.tsx` (544), always false. Delete the branches and the shared type field;
   leave the column, since restore reads old backups.
3. **`portfolio_accounts` has writers and no reader.** `frozenPortfolio` (`snapshot.ts`) and
   `remapPortfolioAccounts` (`accounts.ts`) still fill it; nothing reads it since Investments moved
   to the timeline. Delete both and the column's mentions, or give it a reader.
4. **Beam comparability compares counts, not members.** `comparableHistory` (`BalanceScale.tsx`)
   treats two measured sheets as comparable when their covered and total counts match, so two sheets
   over different accounts of the same size join. Compare the account sets.
5. **Stale header essay in the Balance screen** (sweep finding 67, half done). The header of
   `Instrument.tsx` still narrates deleted screens and a line count nothing re-measures. Cut it.
6. **Category colour swatches.** Four hex literals remain in `settings/CategoriesSection.tsx` as the
   colour picker's options. Route them through tokens, or document why the picker needs literals.

## Data waiting on the bank feed

7. **Two bounced Fidelity deposits** (Apr 15 and May 15, 2026) are stored by SimpleFIN with both legs
   positive, overstating money put in by $400 and keeping April estimated on the history chart. Left
   as reported by rule; an owner correction through `amount_source` would settle it if the owner asks.
8. **Three FSKAX buys** (Aug 4, 11 and 18, 2026) sit above Fidelity's floor and the feed never
   delivered them. If SimpleFIN still has not sent them by the next statement, add them with an
   owner decision about the floor.
9. **Chase's $300 to Coinbase on Oct 16, 2026** has no Coinbase deposit yet (the day's two buys total
   $299.98). Check after the next sync that the deposit arrived and paired.

## Owner

10. **Push.** Commits on `main` are unpushed until git has a GitHub login (`git push origin main`).
11. **Cloud backup** of `.mizan/` and `data/`, plus the keychain key that decrypts
    `credentials.json` (`security find-generic-password -s mizan -a encryption_key -w`), which does
    not travel with the folder. Nothing is backed up on this device by choice.
12. **Not app work, recorded so it is not lost:** the missed October Chase Sapphire autopay (call
    about fees, confirm the Nov 10 payment), the IRA limit for the 2026 room estimate, and whether
    BofA's backup withholding means a tax-ID form was never filed.

## Decided, not to build

- Sortable ledger headers and `aria-sort`: the ledger has no column headers to sort, and the unused
  sort plumbing was removed in 4a896f9.
- The Bone and Signal palette versus pure black and white (Part IV finding 9): a recorded design
  decision.
- `CLAUDE.md` stays gitignored, by the owner's choice.
