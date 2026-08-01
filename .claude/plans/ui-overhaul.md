# UI overhaul — review and plan

Written 2026-07-27. Basis: every view screenshotted at 1440 / 1180 / 820 / 390px against the real
`.mizan/mizan.db`, plus a seven-slice source audit (177 findings, 102 of them falsifiable, 1 refuted
under adversarial verification).

Evidence: `scratchpad/shots/*.png` (session-local, not committed).

---

## Diagnosis

The app is not ugly. It has a real art direction — warm paper, Newsreader serif, sage/clay, the
Arabic mīm mark — and Accounts, Reports, Onboarding and the command palette prove it can look good.
The problem is that the direction is **declared in tokens and never expressed in pixels**, and that
three mechanical defects make the whole thing read as flat, boring and buggy.

### 1. A build-level bug deletes an entire class of styling

`tailwind.config.js:10-84` defines every palette colour as a bare `var(--mz-*)` string. Tailwind 3
cannot apply an opacity modifier to that — `withAlphaValue` bails, and the utility emits **no CSS at
all**. Three auditors independently compiled the real config against a probe file to confirm it.

16 call sites are silently dead. The consequences are not cosmetic:

| Class | Where | What the user sees |
|---|---|---|
| `bg-line/70`, `bg-line/50` | `SkeletonLoader.tsx:2,36,37,39,49,50,51` | **Every skeleton in the app is an invisible blank box.** Loading looks like an empty screen. |
| `bg-ink/25` | `Modal.tsx:35` | **Modals and the palette have no scrim.** Only the inline `backdropFilter` survives, so the page behind stays fully legible. |
| `bg-clay/5`, `border-clay/30` | `QueryErrorBanner.tsx:63` | The one component whose job is "this screen is broken" renders untinted with Tailwind's default grey border. |

This is a known constraint from the Balance redesign that regressed. Fixing it is one config change
and instantly repairs loading, dialogs and error reporting across the app.

### 2. No depth, no scale, no register

- **One `box-shadow` in the entire client** (`Advisor.tsx:101`). There is no elevation model.
- **Cards are invisible.** `--mz-card #faf5ea` on `--mz-paper #f3ede1` is **1.07:1**. A card is held
  apart from the page by a single hairline and nothing else.
- **28 distinct font sizes**, 25 of them arbitrary px literals, most clustered 11–15px — including
  half-pixel values (`13.5`, `12.5`, `11.5`, `14.5`, `15.5`, `16.5`). `theme.extend` has no
  `fontSize`, `spacing`, `boxShadow` or `zIndex` scale at all. Everything is the same size, so
  nothing is important.
- **The muted text ramp fails WCAG AA**, measured against paper (L 0.8500):

  | Token | Hex | Contrast | Verdict |
  |---|---|---|---|
  | `--mz-muted` | `#8c8272` | **3.24:1** | fails AA body (used 276×) |
  | `--mz-muted-2` | `#a89a84` | **2.36:1** | fails everything |
  | `--mz-faint` | `#b3a894` | **2.01:1** | fails everything |

- **Nothing responds to the pointer.** Row hover is a 1.04:1 tint; the separator is 1.09:1; there are
  zero `active:` states; `InkButton` hover is a 10% opacity shift. Command-palette keyboard selection
  is `bg-rail` on `bg-card` — **1.12:1**, i.e. you cannot see which row Enter will fire.
- **The design system is not adopted.** `Card` and `Tooltip` have **zero usages** outside `balance/`;
  `Row` has exactly one (`Accounts.tsx:148`). Meanwhile 16 sites re-implement the card shell inline as
  `rounded-xl border border-line-2 bg-card`. `lucide-react` is a dependency used in 8 files and in
  **none of the 12 primary views**.

### 3. Layout does not earn its space, and the shell has no spine

- **Budget, Goals, Review and Advisor are ~90% empty at 1440px.** Budget renders one category and one
  bar, then 1,100px of nothing.
- **Transactions has a ~700px dead gutter** between merchant and account, no date column, and ~78px
  rows — about 8 of 108 transactions visible at once.
- **Today's spending table is capped at `max-w-[560px]`** inside an ~1,100px column, under a
  full-width rule (`Today.tsx:322`). The mismatch reads as a rendering fault.
- **There is no top bar, no breadcrumb, no persistent sense of place.** Global search is disguised as
  the logo.
- **Below `xl` (1280px) the nav is 12 identical 7px dots** at 1.61:1 contrast with no labels and no
  icons. This covers every window narrower than 1280px, including a non-maximised laptop window.

---

## Bugs (independent of the redesign)

Ranked by what a user hits first.

### Blocking

1. **⌘R and ⌘P are hijacked app-wide.** `NavRail.tsx:56-69` matches `e.key` against nav shortcuts
   including `r` (Review) and `p` (Reports) and calls `preventDefault()`. Reload and print are dead.
   ⌘1–⌘9 also swallow browser tab switching. → Scope shortcuts to a non-conflicting modifier, or drop
   the single-letter ones.
2. **Transactions is unusable below ~500px.** `Transactions.tsx:506` gives the merchant `flex-1` next
   to fixed `w-[130px]` account and `w-[110px]` amount columns with no responsive variant. At 390px
   the merchant name collapses to 0px and the category pill overlaps the account text. Verified in
   `shots/transactions-390.png`.
3. **Cash Flow's "Top spending · July" shows all-time totals.** `api.ts:461` sends `?month=`;
   `server/src/routes/reports.ts:137-145` reads only `startDate`/`endDate` and drops it, so
   `getSpendingReport` runs unbounded. Shopping renders **$22,735** for a month whose total expenses
   were **$2,371**. Confirmed against both endpoints.
4. **No catch-all route.** `App.tsx:51` has no `path="*"`, so any unknown URL renders a blank page
   with no nav.
5. **Modal has no scroll containment.** `Modal.tsx:56` has no `max-height`/`overflow`, so tall forms
   are clipped off both edges of the viewport and are unreachable.

### High

6. **The nav rail always says "Not synced yet."** `useSyncStatus.ts:38` only sets `lastSynced` on a
   live `sync_complete` SSE event; `store/index.ts:39` initialises it to `null`. Every page load
   reports "not synced" while Accounts correctly says "synced 30m ago" — with a *green* dot.
7. **`TrendChart` hover dot never sits on the line.** `TrendChart.tsx:87` computes `hoverYPct` as a
   percentage of `VIEW_H`; line 114 divides by `VIEW_H` again. Correct only at `height === 140`;
   wrong at 3 of the 4 call sites. Found independently by four auditors.
8. **Six views have no loading state and flash their empty state on every fetch.** Skeletons exist in
   4 of 14 views; `CashFlow.tsx` never reads `isLoading` at all. `AccountDetail.tsx:121` shows a
   false "No transactions for this account yet" on every visit. Budget's month switcher unmounts the
   whole list, so every arrow press flashes empty.
9. **`ReviewInbox` shares one mutation across all rows** (`:705`) — acting on one row disables the
   button on every row. Bulk dismiss (`:864`) fires N unbounded parallel PATCHes with one error toast
   per failure.
10. **A single dropdown pick in Review permanently recategorises a whole merchant cluster and writes
    a merchant rule** (`ReviewInbox.tsx:521`) with no confirmation and no undo affordance.
11. **`Modal` and `CommandPalette` are not dialogs** — no `role`, no `aria-modal`, no focus trap, no
    focus restore, no scroll lock. Used by 8 screens.
12. **43 `<label>` elements, zero `htmlFor`.** Every modal form field is unlabelled to assistive tech.
13. **`.mz-field` kills the only focus ring in the system.** `index.css:87` sets
    `focus:outline-none focus:ring-0` over the global `:focus-visible` rule, leaving a 1.07:1 border
    change on 31 inputs.
14. **Settings rows are un-focusable divs** (`Settings.tsx:30`) — the screen is keyboard-dead. Same
    pattern in `Transactions.tsx:487` and the `Row`/`Card` primitives.
15. **Cash Flow's bar chart overflows and clips** at 1Y/2Y/All: `CashFlow.tsx:106` uses a
   non-shrinkable `gap-7` per month with no `min-w-0`.

### Medium

16. Sync "Succeeded" is painted with the **gold/warning** token (`SyncActivityPanel.tsx:22`) — a
    clean sync reads as a caution.
17. **Expenses are green in one chart and tan in another on the same screen.** Cash Flow's bar chart
    uses `bg-tan` for expenses; its own "Top spending" bars below use sage, the income colour.
18. **Category dots use the pre-redesign palette.** `CategoryPicker.tsx:109,156` render raw
    `category.color` from the DB — `#e07070`, `#4ecba3`, `#5b8dee`, `#7c6ea6`. Saturated web colours
    against a warm-paper page.
19. `Reports.tsx:125` references `var(--rail)`, which is not defined (`--mz-rail` is), so zero-value
    bars silently fall back to a hardcoded off-palette `#e6e1d8`.
20. `AccountDetail.tsx:106` renders `{h.quantity} units` raw — "0.06339040967360222 units".
21. Review lands on "Needs category · 0" while "AI suggestions · 14" holds all the work.
22. Toasts (`Toast.tsx:58`) render over the nav rail, covering Settings and the sync indicator.
23. Bulk-action bar in Transactions replaces the column header in normal flow and is not sticky.
24. Every filter keystroke wipes the list to skeletons — no `placeholderData` on the infinite query.
25. Advisor force-scrolls on every streamed token, with no scroll anchoring or jump-to-latest.
26. Bills marks an overdue item by appending `· overdue` to a 12px 2.36:1 grey string.
27. `/onboarding` is an orphan route nothing links to.
28. Chart palette has two adjacent entries at 1.00:1 (`chartColors.ts:9`).

---

## Plan

Each phase is independently shippable and visibly different. Order is chosen so the cheapest,
highest-leverage work lands first.

### Phase 0 — Repair the token layer *(S, one commit, unblocks everything)*

- Convert the palette to channel triplets so alpha modifiers work: define `--mz-*` as
  `42 36 28`-style triplets and map Tailwind colours to `rgb(var(--mz-ink) / <alpha-value>)`.
  Verify with a compiled probe, not by eye — the failure mode is silent.
- Delete the `--rail` reference in `Reports.tsx:125`.
- Restore the focus ring: drop `focus:outline-none focus:ring-0` from `.mz-field`.

Immediate visible effect: skeletons appear, dialogs get a scrim, error banners tint, focus is visible.

### Phase 1 — Give the system a spine *(M)*

- **Type scale.** ~8 named `fontSize` steps with explicit line-heights (`micro` 10.5, `caption` 11.5,
  `body` 13.5, `body-lg` 15, `title` 19, `figure` 22, `display` 27, `hero` 38). Codemod the 25
  arbitrary literals onto them. Kill every half-pixel size.
- **Elevation.** Three warm shadow tokens keyed to the ink hue, not black — black on `#f3ede1` reads
  as dirt:
  ```js
  boxShadow: {
    e1: '0 1px 2px rgb(74 66 52 / 0.06)',
    e2: '0 4px 12px -2px rgb(74 66 52 / 0.10), 0 2px 4px -2px rgb(74 66 52 / 0.06)',
    e3: '0 16px 40px -8px rgb(74 66 52 / 0.18), 0 4px 10px -4px rgb(74 66 52 / 0.10)',
  }
  ```
  `Card` → `e1`. Modal/palette/dropdowns → `e3`. Toasts → `e2`.
- **Contrast.** Darken the ramp until it passes: `muted` → ~`#6f6555` (4.6:1), `muted-2` → ~`#857a68`
  (3.6:1, labels only), retire `faint` for text. Introduce `--mz-track #ded3bf` so progress tracks
  and separators are visible.
- **Interaction states.** `active:translate-y-px` on buttons, a real hover tone (`#e6ddc9`, ≥1.25:1)
  plus a 2px sage left-edge marker on rows, a visible selected state (border + `bg-card` +
  `font-medium`, three redundant signals).
- **A `<Money>` primitive** with `hero`/`figure`/`row`/`meta` variants, one numeral family, one
  rounding rule per variant. Net worth currently renders in three fonts, three sizes and two rounding
  conventions across three screens.
- **Adopt the primitives.** Either migrate the 16 inline card shells onto `Card` (adding the
  `elevated` / `inset` variants they actually need) or delete the dead primitives. Not both.

### Phase 2 — Build the shell *(M)*

- **Top bar**: page title, breadcrumb, a real global search control (not the logo), and a home for
  date-range / account filters.
- **Nav icons.** `lucide-react` is already a dependency. Icon + label at `xl`, icon + tooltip below,
  never a bare dot.
- **Mobile nav**: bottom tab bar or drawer below `md`. The 56px dot strip should not exist on a phone.
- **Fix the keyboard shortcuts** (bug 1) and add `path="*"` (bug 4).
- **Dialog semantics** for `Modal` and `CommandPalette`: `role`, `aria-modal`, `aria-labelledby`,
  focus trap, focus restore, scroll lock, `max-h` + `overflow-y-auto`.

### Phase 3 — Rebuild the ledger *(L — the highest-traffic screen)*

- Real columns: **date · merchant · category · account · amount**, tabular numerals, decimal-aligned.
  Kill the dead gutter. Target ~44px rows, roughly double the current density.
- **Totals**: filtered sum in the header (server-side, not a sum of loaded pages) and a per-day net on
  each group header.
- **Sortable headers** with `aria-sort` — the server already implements sorting, amount-range and
  income/expense filtering, and the UI exposes none of it.
- **Selection**: persistent checkboxes (not hover-revealed), select-all, Shift+Click ranges, a bulk
  menu beyond "set category", and a sticky action bar.
- **Row flags**: pending, transfer, duplicate/excluded, recurring, has-note. The `Transaction` type
  carries all of it and the row shows none of it.
- **Responsive**: stacked two-line rows below `md`. Fixes bug 2.
- Keyboard navigation and `<button>`/`<Link>` semantics throughout.

### Phase 4 — Make the charts charts *(M)*

Nine of the ten "charts" outside `TrendChart` are `<div>`s with a percentage width.

- Every value chart gets a zero baseline, 3–4 gridlines at rounded values, right-aligned tick labels,
  first/last x labels, and a persistent last-value annotation.
- Cash flow → diverging columns around zero. Category spend → horizontal bars on a shared axis with
  end labels. Allocation → keep the stacked bar, fix the palette collision.
- Fix `TrendChart`: the hover-dot double division (bug 7), `preserveAspectRatio="none"` distorting
  stroke weight, index-spaced (not time-spaced) x-axis, and the all-estimated series drawn as a
  confident solid line.
- **Drill-down**: every category, merchant, month and account navigates to `/transactions` with the
  filter pre-applied. Nothing on Reports/CashFlow/Investments is currently clickable.
- One semantic rule, enforced: income sage, expense clay, forecast/caution gold. No more tan expenses.
- `<title>`/`<desc>` and a table fallback for assistive tech.

### Phase 5 — Fill the empty screens *(M)*

- **Today**: the scale moves ~3px across the entire range of real balance sheets — either log-scale
  the tilt to ~20° max or shrink it to a 120px mark and give the space to the 12 months of net-worth
  history the screen already fetches and renders zero pixels of. Uncap the 560px table. Promote the
  month figures out of a 10.5px uppercase label.
- **Budget**: month-over-month comparison, group rollups, a pace tick at `daysElapsed / daysInMonth`,
  and an over-budget treatment that reads as urgent — `ProgressBar` currently hard-clamps at 100%, so
  "$25 over" looks identical to "exactly on budget" except for a 1.37:1 hue shift on a 6px bar.
- **Bills**: 30/60/90 range control, sticky week headers with subtotals, a month-grid heatmap, and
  collapse repeating series (six "bluebik rides" rows at $1.91 currently dominate the list).
- **Goals**: `goalForecast.ts` computes status, severity and risk counts that render nowhere. Drive
  the bar tone from severity and show the shortfall as an actionable number.
- **Investments**: ~460 of 601 lines of `investmentAnalytics.ts` are wired to nothing — surface
  concentration, drift against `STARTER_ASSET_TARGETS`, and an activity strip.
- **Advisor**: a real composer (bordered, with a send button and a stop control), suggested prompts as
  chips, message grouping, copy/retry, scroll anchoring, and a container for the context panel.
- **AccountDetail**: format quantities, add actions, filters, and the fields a credit card or loan
  actually needs.

### Phase 6 — States and accessibility *(M)*

- A skeleton matching the final layout in all 14 views; never render an empty-state sentence while
  `isPending`. `placeholderData` on every filter/month query.
- Designed empty states (mark, one line, one CTA) instead of a grey sentence.
- `htmlFor` on all 43 labels; `aria-live` on toasts; `aria-sort`, `aria-expanded`, `aria-current`
  where they belong; keyboard access on every interactive row.
- Review should open on the first tab with work.

### Phase 7 — Dark mode and motion *(L)*

Settings already shows an inert "Appearance: Light" row. Phase 0's channel-triplet tokens make this
tractable: add a `:root[data-theme="dark"]` block, a warm-dark paper scale, and re-derive the sage /
clay / gold ramps for dark. Then a consistent motion pass — the `mz-*` keyframes exist but most
interactions have no transition at all.

---

## Sequencing note

Phases 0 and 1 are prerequisites for everything visual; do them first and in order. Phase 2 (shell)
and the bug list can proceed in parallel with them. Phases 3–5 are independent of each other and can
be reordered by whatever is most annoying day to day — Transactions is the highest-traffic screen,
so it is placed first by default.
