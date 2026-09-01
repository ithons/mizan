# UI overhaul, trimmed to the one thing worth keeping

Written 2026-07-27; trimmed 2026-09-01 per `rebuild-part-3.md` Decision 4, which specified this file
be "trimmed to a stub and folded, not deleted" and then tracked. The tracking happened at commit
906c75e and the trim did not, so the repo shipped a Diagnosis section describing a palette and a set
of defects that no longer exist: an `/alpha` build bug that is fixed, `--mz-paper #f3ede1` against
`--mz-card #faf5ea` at 1.07:1 when both grounds are now pure white and pure black, and layout
findings that Phases 7b, 8 and 9 shipped under other names. A reader arriving at it would have
formed a correct-sounding and wholly false model of the app.

**Where its content went.** The token, type-scale, elevation, dark-mode and chart phases shipped in
7b, 8 and 9. The Advisor items are moot: Phase 8 deleted the Advisor tab rather than improving it.
The five genuinely unshipped items moved into `rebuild-part-3.md`: `role`/`aria-modal` and focus
restore into Phase 12, and `htmlFor`, `aria-live`, `aria-sort`, sortable headers and chart drill-down
into Phase 14.

**What stays, and why.** The `/alpha` diagnosis below, because it is load-bearing evidence rather
than history: three auditors independently compiled the real Tailwind config to establish that
`withAlphaValue` drops the utility silently, and that measurement is the reason
`tests/edgeToken.test.ts` exists and the reason the palette is declared twice in `index.css`. It is
kept in its 2026-07-27 tense and describes the state BEFORE the fix. One em dash in it was
replaced with a colon, because the no-em-dash rule is absolute and predates nothing.

---

### 1. A build-level bug deletes an entire class of styling

`tailwind.config.js:10-84` defines every palette colour as a bare `var(--mz-*)` string. Tailwind 3
cannot apply an opacity modifier to that: `withAlphaValue` bails, and the utility emits **no CSS at
all**. Three auditors independently compiled the real config against a probe file to confirm it.

16 call sites are silently dead. The consequences are not cosmetic:

| Class | Where | What the user sees |
|---|---|---|
| `bg-line/70`, `bg-line/50` | `SkeletonLoader.tsx:2,36,37,39,49,50,51` | **Every skeleton in the app is an invisible blank box.** Loading looks like an empty screen. |
| `bg-ink/25` | `Modal.tsx:35` | **Modals and the palette have no scrim.** Only the inline `backdropFilter` survives, so the page behind stays fully legible. |
| `bg-clay/5`, `border-clay/30` | `QueryErrorBanner.tsx:63` | The one component whose job is "this screen is broken" renders untinted with Tailwind's default grey border. |

This is a known constraint from the Balance redesign that regressed. Fixing it is one config change
and instantly repairs loading, dialogs and error reporting across the app.

---

*(End of the kept section. Everything that followed it in the original file has been folded into
`rebuild-part-3.md` or shipped; see above.)*
