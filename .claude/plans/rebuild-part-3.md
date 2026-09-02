# mizān rebuild, part III: the visual instrument

Written 2026-07-31, after Phases 5b through 10 landed and Phase 9 verified them against the owner's
real database. Part I is `rebuild.md`, Part II is `rebuild-part-2.md`; both stay the record of what
was found and what shipped. This file is the plan for the redesign and for everything Part II left
open.

Basis: a measured diagnosis of the palette, four independently authored candidate palettes, two
adversarial judgements that disagreed, and an independent re-derivation of every disputed figure.
The re-derivation is what decides the disagreement, and it is recorded below with the script beside
it.

The governing rules from Parts I and II are unchanged and this plan is organised around them:

> A defect is fixed in the write path, with a regression test, not by repairing the database.
> Never a claim, in code or in copy, that the code did not check.
> A detector must be silent on an ordinary healthy event.

The third one applies to pixels here, and that is the whole argument of Phase 13: colour states a
KIND, never a quality, and a healthy ledger must be almost colourless.

---

## What was measured, and by which script

Everything below was computed by scripts I wrote and ran during this planning pass. All of them read
the shipped 8-bit triplets, never an authoring target. Nothing in the repo was written to.

| script | what it computes |
|---|---|
| `scratchpad/plan-verify/cm.mjs` | sRGB/linear/XYZ D65/CIELAB, OKLab and OKLCH, WCAG 2.1, CIEDE2000, Machado Oliveira Fernandes 2009 CVD at severity 1.0. Smoke test: black on white returns exactly 21.00. |
| `scratchpad/plan-verify/run.mjs` | parses `client/src/index.css`, prints a transcription check, then measures all five palettes (current plus four candidates) on ten axes. |
| `scratchpad/plan-verify/solve.mjs` | the border lightness budget, the ramp transplants, and the colour-blindness sweep for the money pair. |
| `scratchpad/plan-verify/band.mjs` | the `line-2` lightness band on the chosen palette's own surfaces. |

Transcription check printed by `run.mjs`: **45 `--mz-*-c` tokens in `index.css`, all 45 declared in
all three theme blocks, 0 disagreements between the `@media (prefers-color-scheme: dark)` block and
the `:root[data-theme='dark']` block.** So the file is internally consistent today and every figure
below is measured against what ships.

Baseline before anything moves:
`node --test --import tsx tests/{seriesPalette,edgeToken,cardElevation,navigation,railGround,accountsRowContrast,categoryRamp}.test.ts`
returns **107 pass, 0 fail**.

---

## Decision 1: build Bone and Signal, with three grafts

### Resolving the judges

The two judgements disagree, and they disagree because they measured different things. Judge 1
rendered each palette as a whole screen and ranked Bone and Signal first. Judge 2 re-derived every
published figure from the emitted triplets and ranked Foolscap first. Neither is wrong about what it
looked at. I re-derived independently, and the result eliminates two candidates outright and turns
the remaining choice into a question about the brief rather than about arithmetic.

**Nightwatch is out: its figures do not reproduce from its own triplets.** Eight spot checks against
the values it emitted, `solve.mjs` section E:

| pair | claimed | measured |
|---|---|---|
| ink on paper, light | 12.15 | **10.93** |
| ink on card, light | 14.83 | **13.68** |
| clay on paper, light | 8.21 | **6.91** |
| clay on card, light | 10.02 | **8.65** |
| sage-deep on paper, light | 6.02 | **5.36** |
| gold on paper, light | 5.42 | 5.42 |
| clay on dark card-white | 5.29 | **4.73** |
| ink on paper, dark | 12.68 | **13.14** |

Seven of eight miss, by up to 1.34. Separately, its dark series ramp puts 6 of 8 slots outside the
OKLCH lightness band `[0.48, 0.67]` that `tests/seriesPalette.test.ts` already enforces (measured
0.67, 0.82, 0.80, 0.70, 0.82, 0.69, 0.69, 0.61), and its light ramp measures adjacent protan/deutan
6.6 against the test's target of 8. A proposal whose deliverable is 70 prose figures that Tier A
tests regex-match cannot ship figures that do not reproduce.

**Bone and Verdigris is out: it fails three gates the test suite already asserts, and it breaks the
one invariant the palette is built around.** Measured in the metric `seriesPalette.test.ts` actually
computes (OKLab dE times 100, `run.mjs` section 5): chroma floor fails at 0.089 light and 0.088 dark
against a floor of 0.10; adjacent normal-vision separation is 13.8 in both themes against a floor of
15; adjacent protan/deutan is 6.8 light against a target of 8. And the inverted-chroma invariant is
**negative in light**: quietest semantic ink `pill-text` 0.0683 against loudest furniture
`review-border` 0.0688, margin **-0.0005**. That is the same class of defect this file exists to
stop, reproduced in the proposal meant to fix it. It is also, by its own numbers, the smallest change
from the palette the owner called vomit.

That leaves **Bone and Signal** and **Foolscap**, the two whose every figure I checked reproduced
exactly and whose ramps pass every gate the test enforces. On the objective faults, `run.mjs`
sections 1, 3 and 9, with the current palette for scale:

| | Fault 1: 20-neutral CIELAB Cab, mean / count at Cab>=5 | Fault 3: the three rungs `Card.tsx` actually builds | Fault 4: gold vs review-text dE2000 |
|---|---|---|---|
| current | 10.27 light, 17 of 20 | 1.69 / 1.80 / 2.04 light, 1.66 / 1.53 / 1.93 dark | 2.19 light, 5.18 dark |
| Bone and Signal | 3.62 light, 4 of 20 | **2.39 / 2.45 / 3.87 light, 2.04 / 1.63 / 3.33 dark** | 51.64 / 46.65 |
| Foolscap | **2.03 light, 0 of 20** | **5.22 / 5.43 / 7.53 light, 3.71 / 3.21 / 3.87 dark** | 46.35 / 46.36 |

Foolscap wins Fault 1 and Fault 3 on the numbers. Three things decide against it anyway.

**First, it has a correctness defect a money instrument cannot carry, and it is worse than the
palette being replaced.** `run.mjs` section 2, sage-deep against clay, dE2000 with Machado
simulation at severity 1.0:

| | normal | protan | deutan | dL\* |
|---|---|---|---|---|
| current light | 45.42 | 9.95 | **1.08** | 2.80 |
| current dark | 46.48 | 13.62 | 5.50 | 10.29 |
| Foolscap light | 64.73 | 13.84 | **5.05** | 0.29 |
| Foolscap dark | 59.97 | 15.74 | **2.39** | 4.81 |
| Bone and Signal light | 58.92 | **6.81** | 13.72 | -1.47 |
| Bone and Signal dark | 57.86 | 14.68 | 7.06 | 11.60 |

Income and debt are one ink to a deuteranope in Foolscap's dark theme at dE2000 2.39, which is
**below** the current palette's 5.50. Six inks all parked near L\* 36 means the accents separate by
hue alone, and hue alone is what dichromacy removes. Note this is a live defect today too: the
current palette's light deutan figure is **1.08**, effectively identical. No candidate is clean here
and the fix is specified below, but a direction whose central mechanism makes the binding case worse
is the wrong base.

**Second, its own writeup concedes it does not deliver the brief.** It says outright that it gives
more colour contrast around a near-monochrome field, not more colour. The owner asked for more
colour. That is a legitimate design position and it is not the one that was asked for.

**Third, it discards the warm paper the diagnosis explicitly classed as taste rather than defect.**
Foolscap takes the 20-neutral field to Cab 2.03. Bone and Signal takes it to 3.62, which is a warm
white rather than a khaki, and keeps the Newsreader-on-paper pairing the app has already earned.

Bone and Signal's flaw is Fault 3 and it is one token wide. `solve.mjs` section A solves the
3:1 budget on Signal's own surfaces:

```
light  paper      L* 90.0   border must reach L* 54.1
light  card       L* 98.6   border must reach L* 60.6
light  card-alt   L* 99.6   border must reach L* 61.4
dark   card       L* 19.1   border must reach L* 49.9
dark   card-alt   L* 25.9   border must reach L* 56.2
Signal ships line-2 at L* 67.6 light and 39.3 dark; line-3 at 53.9 light and 59.3 dark.
```

`line-3` already clears in both themes. `line-2` misses in both, by 7.0 L\* in light and 16.9 L\* in
dark, and it is the token `Card.tsx` uses for **both** e1 and e2. Move that one token and the ladder
is fixed. Foolscap's flaw is a direction. Signal's is a triplet.

### The three grafts, with their budgets

**Graft 1, from Foolscap: the principle that structure lives on the border, re-authored to Signal's
own budget.** Not Foolscap's triplets. I tested the raw graft (`solve.mjs` section B): Foolscap's
line tokens dropped onto Signal's surfaces give light 5.43 / 5.57 / 7.71, which is good, and dark
3.67 / **2.94** / 3.53, where e2 fails. Re-author instead at Signal's own hue and chroma to the band
`band.mjs` solved:

```
light line-2, hue 76.6 chroma 0.012 held:
  L* 52 -> e1 4.05  e2 4.15  vs paper 3.25   rgb 128 123 117
  L* 55 -> e1 3.64  e2 3.72  vs paper 2.91   rgb 136 131 124
  L* 60 -> e1 3.06  e2 3.14  vs paper 2.45   (no margin, do not ship here)
dark line-2, hue 76.5 chroma 0.013 held:
  L* 58 -> e1 3.99  e2 3.20  vs paper 5.48   rgb 144 139 131
  L* 60 -> e1 4.26  e2 3.41  vs paper 5.85   rgb 149 144 137
  L* 62 -> e1 4.56  e2 3.65  vs paper 6.25   rgb 155 149 142
```

Target light L\* 52 to 55 and dark L\* 60 to 62. That takes the rungs from 1 of 3 to 3 of 3 in both
themes and makes the dark ladder monotone, which it is not as Signal ships it (e1 2.04 then e2 1.63).
Six triplet lines.

**Graft 2, from Nightwatch: the lightness budget for the money pair, and nothing else from it.** Its
contrast figures do not reproduce, but its structural insight does. It is the only candidate where
sage-deep against clay clears dE2000 9 under both red-green types in both themes (light 12.08 /
11.70, dark 13.05 / 9.32) and it buys that with lightness separation. `solve.mjs` section D sweeps
clay on Signal's own hue and chroma:

```
light, sage-deep at L* 35.0, clay hue 24.9 chroma 0.175:
  clay L* 28 -> protan 12.68  deutan 11.75   on paper 7.83  card 9.77  rail 8.80  well 6.78
  clay L* 31 -> protan 10.73  deutan 12.13   on paper 6.99  card 8.73  rail 7.86  well 6.06
  clay L* 36 (as shipped) -> protan 6.81
dark, sage-deep at L* 84.3, clay hue 25.0 chroma 0.129:
  clay L* 66 -> protan 19.85  deutan 11.32   on well 4.26   (breaks AA on the hover wash)
  clay L* 70 -> protan 16.60  deutan  8.52   on well 4.87
  clay L* 73 (as shipped) -> deutan 7.06
```

Light is clean: clay at L\* 28 to 31 gets both red-green types above 10 and every ground stays well
clear of AA. Dark is a genuine tension and it must be stated rather than dressed up: the floor is set
by `well`, the hover wash `Row` applies to every list row in the app. Holding sage-deep and `well`
where Signal ships them, clay at L\* 68 to 70 is the only window that reaches roughly 8.5 to 10 under
deuteranopia while keeping clay above 4.5 on that wash. If a higher target is wanted, `well` has to
come down toward `card`, which costs the hover lift. Solve the dark theme jointly over
(sage-deep, clay, well) and record which constraint bound.

**Graft 3, from nobody: keep Bone and Signal's own series ramp.** Judge 1 recommended taking
Foolscap's ramp outright on the grounds its worst adjacent pair under all four vision types
(28.2 / 29.3) is roughly double every other candidate's (13.7 to 20.4). That comparison is between
two different metrics. Foolscap reported CIEDE2000; Bone and Signal reported OKLab dE times 100,
which is what `tests/seriesPalette.test.ts` computes. Measured in the test's own metric, `run.mjs`
section 5, the order reverses:

| ramp | adj protan/deutan (gate >=8) | adj normal (gate >=15) | adj tritan (unchecked) | worst all-pairs CVD | min contrast on ground (gate >=3) |
|---|---|---|---|---|---|
| current | 12.8 / 13.1 | 20.8 / 20.9 | 8.3 / **5.9** | **4.6 / 3.7** | 3.13 / 3.01 |
| Bone and Signal | **13.7 / 14.3** | 21.0 / 22.6 | **14.5 / 16.0** | 2.9 / 3.3 | 3.01 / 3.16 |
| Foolscap | 11.6 / 11.8 | **24.9 / 24.8** | 13.3 / 14.2 | 2.4 / 2.5 | 3.14 / 3.17 |

Signal's ramp beats Foolscap's on both binding gates and on tritan. The transplant was one-directional
anyway: Foolscap's ramp on Signal's paper clears at 3.32 / 3.46, but Signal's ramp on Foolscap's paper
measures **2.84 / 2.90** and would fail the 3:1 gate (`solve.mjs` section C).

Two honest notes on the ramp. **No candidate improves worst all-pairs separation under dichromacy;
all four regress it,** and the current ramp at 4.6 / 3.7 is the best of the five. Eight categorical
slots cannot be separable all-pairs under dichromacy at any lightness band, so the existing policy
that every legend row carries its label and percentage stays load-bearing and must be stated as
covering tritanopia too. And **the current dark ramp measures adjacent tritan 5.9, below the file's
own `CVD_TARGET` of 8**, which means adding a tritan assertion is a test change that must land with
the palette, not before it.

**Graft 4, from Bone and Verdigris: the measurement method, not a value.** It is the only submission
that measured the rungs the way `Card.tsx` actually pairs them. Confirmed by reading the file:

```
1: 'bg-card border-line-2 shadow-e1'
2: 'bg-card-alt border-line-2 shadow-e2'
3: 'bg-card-alt border-line-3 shadow-e3'
```

The emitter must use that mapping, not an idealised line / line-2 / line-3 ladder, or the docstring
is false the day it lands.

### The invariant that gets rewritten, not restated

`index.css` and `rebuild.md` both assert that `tan 0.041` is the loudest piece of furniture. It is the
sixth-loudest. `run.mjs` section 10, and this reproduces exactly:

```
current light: quietest semantic ink `info` 0.0710, loudest furniture `review-border` 0.0700, margin 0.0010
current dark:  quietest `info` 0.0705, loudest `review-border` 0.0699, margin 0.0006
```

The invariant is true and survives by one thousandth. On Bone and Signal the margin is **0.0336 light
and 0.0332 dark**, with `estimate` exempted. Of the four candidates, only Bone and Signal and
Nightwatch keep it true on the broad furniture reading; Verdigris is at **-0.0005** light and Foolscap
at **-0.0281** light. Rewrite it with its furniture scope stated, its comparator named, `estimate`
exempted in words (Signal's estimate measures OKLCH C 0.0355 light, quieter than most furniture, and
that is deliberate), and a test that re-derives it, so it cannot go stale the way this one did.

### What Bone and Signal delivers, measured

Against the current palette, all from `run.mjs`:

- **Fault 1.** 20-neutral CIELAB Cab mean 10.27 to **3.62** light and 8.66 to **3.88** dark; count at
  Cab >= 5 from 17 of 20 and 18 of 20 to **4 of 20** in both themes.
- **Fault 2.** Positive money leaves the yellow-green band. Six semantic hues spread around the wheel
  with a minimum gap of 32.6 degrees light against 2.1 today.
- **Fault 3.** After graft 1, all three `Card.tsx` rungs clear 3:1 in both themes, from 0 of 3 today.
  Hairlines: `line-3` on card goes 1.91 to 3.78 light and 2.10 to 4.16 dark.
- **Fault 4.** gold against review-text, dE2000 **2.19 to 51.64** light and 5.18 to 46.65 dark.
- **The nine recorded rail exceptions all clear.** `muted-2` 3.67 to **5.85**, `sage-deep` 3.99 to
  **6.78**, `clay` 4.43 to **6.43**, `gold` 3.71 to **6.01** (light).
- **The three pairs the codebase documents by name all clear.** `muted-2` on `well` 4.02/4.14 to
  4.50/5.39, `muted-2` on `pill-muted-bg` 3.92/4.77 to 4.55/6.07, `clay` on dark `card-white` 3.41 to
  **4.64**, which removes the numeric reason `e3` stops raising the surface on dark (the structural
  reason may still stand; re-argue it, do not assume it).
- **`estimate` stays a different kind of ink.** a\* -9.0, b\* -6.8 light; dE2000 from `ink-soft`
  **12.8 to 17.1**. The mechanism changes, though, and this must be written down: it is no longer the
  only cool token, because `review-*` and `info` are cool too. It now separates on distance from the
  ink ramp, not on uniqueness, which is a thinner structural argument and one careless chroma edit
  from collapsing.

### What Bone and Signal does not fix, stated plainly

- **Light-theme surface steps do not reach 3:1 and cannot.** `card` on `paper` is 1.25. A 3:1 step off
  a paper at L\* 90 needs the other surface at L\* 61, which is a mid-grey page. All structural load
  moves onto the border, which is exactly why graft 1 is not optional. If cards keep being drawn with
  a border that does not clear 3:1, the flatness comes straight back and the repalette buys nothing on
  Fault 3.
- **Two light-theme text pairs land on the AA threshold rather than clear it.** `muted-2` on `well`
  measures **4.50** and `estimate` on `well` measures **4.54**. `Row` applies `hover:bg-well` to every
  list row in the app and `muted-2` has 109 call sites, so this is the most-rendered text pair in the
  product sitting five thousandths above the floor. Re-cut both inks a step darker in the same pass,
  or move `well`. Do not ship 4.50 and call it clearing.
- **Worst all-pairs series separation under dichromacy regresses** from 4.6 to 2.9 light and 3.7 to
  3.3 dark. Identity by label stays mandatory.
- **`--mz-info` has a channel form and no composed alias.** Verified: `--mz-info-c` appears three
  times in `index.css`, `--mz-info:` appears zero times. Constraint A's duality is already broken for
  exactly one token, and nothing catches it because nothing references `var(--mz-info)`. Fix it in the
  same commit.

---

## Order, and why

1. **Phase 11 first, and it is small.** The mis-signed brokerage rows are $1,800 of wrong money on
   screen and the oldest unclosed defect in the repo. It shares **zero files** with the redesign
   (`server/src/services/simplefin.ts` and a migration, against `client/src/index.css` and tests), so
   it is not competing with Phase 12 for a slot. If the owner wants the redesign first, run 12 first;
   the ordering here is a preference, not a dependency, and this is the only place in the plan where
   that is true.
2. **Phase 12, the repalette, is the headline.** It goes before the graphic layer because the graphic
   layer's structural rung is *defined in terms of the palette* and does not survive the swap. See
   Phase 13.
3. **Phase 13, the graphic layer, is downstream of 12, hard.** Not by preference.
4. **Phase 14, accessibility, after 13** because the graphic layer changes what has to be announced.
   Two items are pulled forward into 12 because they depend on nothing.
5. **Phase 15 last**: freezing snapshot membership, the maintenance sweep, and the record.

---

## Phase 11: the recorded correction

**What it changes.** The 12 of 14 `Electronic Funds Transfer Received` rows on Fidelity Individual
that arrive negative from the provider, against the owner's own
`data/fidelity/Accounts_History.csv` showing them positive, become a **recorded** correction rather
than an uncorrected report. Migration 048 built `amount_source` and `transaction_field_revisions`
for exactly this and **nothing has ever used them**. This is the phase that uses them.

- Write the owner's value into the row, set `amount_source` to record that it is not the provider's
  number, and write a `transaction_field_revisions` row naming both values.
- `upsertSimplefinTransaction` must consult `amount_source` before it compares and overwrites
  `amount`. This is the whole point. A repair that does not change the write path reverts within the
  hour, and that trap is documented in three places in this repo.
- The two `... as of <date>` reversal rows are correct as negatives and must not be touched. The
  correction is keyed on the specific rows, and a row whose provider value later agrees with the
  owner's must drop out of the revision set rather than accumulate.

**Why here.** It is wrong money, it is the oldest unclosed defect, and it is the last piece of
infrastructure built and never wired. It is also completely independent of everything else in this
plan, which is why it is small enough to lead.

**What proves it worked.** A test that runs a second sync against the same provider payload and
asserts the corrected amount survives it. That is the assertion the self-reverting-repair trap
demands and the one no existing test makes. Plus: the estimated net-worth series no longer flips sign
at 2026-01-01, the reconciliation residual on Fidelity moves from +$783.89 toward the true -$16.11,
and `buildFinancialContext` stops telling the model `investments: 8 transactions, net -$800.00`.
Re-derive all four against a byte copy of `.mizan/mizan.db` and print the query beside each.

**What it does not do.** It does not touch the SimpleFIN sign logic for balances (`liabilitySign.ts`
is a correction of our own transform and stays exactly as bounded as it is). It does not build a
general "the owner disagrees with the provider" UI. It does not repair any other account. It does not
touch the client.

---

## Phase 12: the repalette

**What it changes.** All 45 tokens across all three theme blocks, to Bone and Signal plus the three
grafts above.

Measured blast radius, all greps run 2026-07-31 against `client/src`:

| what | count | grep |
|---|---|---|
| `--mz-*-c:` triplet lines | **135** | `grep -cE '^\s*--mz-[a-z0-9-]+-c:' client/src/index.css` |
| `--mz-e1/e2/e3/edge` | 12 | `grep -cE '^\s*--mz-(e1\|e2\|e3\|edge):'` |
| legacy `--color-*-c:` | 9 | |
| legacy `--color-*:` | 26 | |
| `index.css` total lines | 625 | |
| raw `var(--mz-*)` outside `index.css` | **41, across 13 files** | `grep -rn 'var(--mz-' client/src \| grep -v index.css` |
| colour-utility occurrences | **1,029** | token-whitelist regex over `bg\|text\|border\|ring\|divide\|fill\|stroke\|...` |
| `/alpha` modifier occurrences | **19, of which 13 in `.tsx`** | the other 6 are `index.css`'s own documentation |
| hex literals | **27**, of which 22 are `CATEGORY_PRESET_COLORS` and **the other 5 are all inside comments** | |
| colour assertions | 107, across 7 files, all passing today | |

Two corrections to the record fall out of that census. `index.css`'s own header says "the ~32 raw
references" and the diagnosis says 38 across 10 files; the real count is **41 across 13 files**
(`chartColors.ts` 10, `SyncActivityPanel.tsx` 8, `TrendChart.tsx` 7, `CategoryPicker.tsx` 4,
`RulesSection.tsx` 2, `CategoriesSection.tsx` 2, `BalanceScale.tsx` 2, and one each in
`constants.ts`, `NavRail.tsx`, `LoadingSpinner.tsx`, `CommandPalette.tsx`, `Select.tsx`,
`AskPanel.tsx`). And the inventory item "one genuine hardcoded hex, `#c9963a` in
`SyncActivityPanel.tsx`" is **stale**: that hex survives only in a comment at line 22 recording what
the defect was. Nothing in `client/src` outside `CATEGORY_PRESET_COLORS` sets a live colour from a
literal. Correct the record, do not schedule the work.

### How it lands, in five gates

**Gate 0, as it actually landed [recorded 2026-09-01].** `scripts/palette-figures.mjs` was never
written; the triplets and the prose landed in one hand-written commit (4a2db38). What substituted
for it is `tests/contrastClaims.test.ts`, which walks `client/src` and re-derives every stated
contrast ratio from the shipped triplets, with a `[historical]` opt-out in the source. That covers
the contrast half of what the emitter was for and is the accepted substitute. It does NOT cover the
OKLCh and L* claims, which are asserted by nothing; and it walks `client/src` only, so the server's
database-derived figures were unguarded until the 2026-09-01 pass re-derived them by hand again,
which is the mechanism this gate existed to end. The `--mz-info` alias was added. The
`index.css` census figures were re-derived in that same pass.

**Gate 0, as written: before a single triplet moves, the emitter exists and reproduces today's file.** One new
script, `scripts/palette-figures.mjs`, which reads the **shipped 8-bit triplets out of `index.css`**
and emits every figure that any test literal or any docstring states. Prove it by running it against
the palette as it ships now and diffing its output against the 70 existing prose figures and the 63
existing test literals. **If it cannot reproduce the current file, it cannot be trusted to write the
next one.** This is the highest-value gate in the plan: of the four candidate palettes submitted,
three published figures that do not reproduce from their own triplets, and Nightwatch missed 7 of 8
spot checks by up to 1.34. The emitter must use `Card.tsx`'s real rung mapping, read out of the
`elevations` object rather than assumed.

**Gate 1, the `/alpha` canary, also before anything moves.** Add a test that compiles the real
`tailwind.config.js` against a probe file containing all 13 live `/alpha` utilities and asserts each
one emits CSS. The 13, listed so nobody has to re-find them: `bg-track/60` (x2, `SkeletonLoader`),
`bg-well/60` and `bg-ink/10` (`CommandPalette`), `border-clay/30` and `bg-clay/5`
(`QueryErrorBanner`), `bg-negative/10` and `border-negative/30` (`ConfirmRemoveModal`), `bg-ink/25`
(`Modal`), `bg-sage/10` (x3, `Settings`), `ring-ink/30` (`CategoriesSection`).

This is the exact failure this codebase already shipped. `withAlphaValue` runs `parseColor()`, gets
null from a bare `var(--mz-x)`, and **drops the utility with no warning**, which deleted every
skeleton, both dialog scrims and the error-banner tint at once. `tests/edgeToken.test.ts` asserts the
channel form is present; nothing asserts the utility *compiles*. Land the canary on the current
palette and watch it pass. A test written after the swap proves nothing, because a green test on a
broken build is exactly what happened last time.

**Gate 2, the triplets land mechanically and alone.** One commit, `index.css` only: 135 triplet
lines, 12 elevation vars, 35 legacy `--color-*` lines. Both dark blocks written from one source so
the media query and the attribute selector cannot diverge. `seriesPalette.test.ts` already asserts
that agreement for the 8 series slots; **extend it to all 45**, because today 37 of them are
unchecked and dark is authored three times over. Also in this commit: add the missing composed
`--mz-info` alias.

Tier A goes red in this commit. That is expected, it is stated in the commit message, and it is the
forcing function: the ladder table in `Card.tsx` and the ratio sentences in `NavRail.tsx` cannot drift
from the tokens because the test reads both.

**Gate 3, the measurement-and-prose commit is machine-written.** The emitter regenerates all 63 exact
literals, all 13 embedded table rows and all 70 prose figures across 14 files. Do not hand-edit them.
Hand-maintaining 70 figures in lockstep to two decimal places is precisely the mechanism by which the
`tan 0.041` claim went stale in the file whose job is to prevent stale claims.

**Gate 4, the owner sees it before it is committed.** The swap is `index.css` only, so it drives with
the dev server against a byte copy of `.mizan/mizan.db`: six screens, both themes, at 1024 / 1280 /
1440. Plus the four states that only exist under load, which are exactly the four the `/alpha` failure
kills: **skeleton, empty, error banner, dialog scrim.** Screenshots to the scratchpad, never the repo.

A palette is the one change where the suite passing and the screen being wrong are fully compatible.
Phase 9 already recorded a selection ring that measured fine and rendered at 1.97:1 because
`opacity-55` composited it away, and `opacity` applies to `box-shadow`. Nothing in the test suite can
see a composite.

**Gate 5, the nine rail sites close as an output, not an input.** They fold in and they do not fight.
All four tones clear AA on the new rail (measured above: 5.85 / 6.78 / 6.43 / 6.01). So
`railGround.test.ts`'s recorded-exception list goes to empty and the test flips from "these nine are
known bad" to "none is bad", which is a strictly stronger assertion. **Do not fix them first.** A
one-class fix on the current palette is work the repalette immediately makes meaningless, and it
touches the same files, so doing it first creates a merge conflict with itself.

### Also in this phase, because they depend on nothing

- `role="dialog"` and `aria-modal="true"` on `Modal.tsx`. Measured today: **0 of each**. A dialog that
  does not announce itself is a defect on any palette.
- Focus restore on dialog close.

### What proves it worked

1. The `/alpha` canary passes before and after, and the four load states render in the browser.
2. All 107 colour assertions pass, re-derived by the emitter, plus the new all-45 dark-block agreement
   check.
3. `railGround.test.ts` has an empty exception list and fails on a tenth site.
4. Both typechecks clean, full suite clean.
5. A CVD assertion for the money pair: sage-deep against clay must clear dE2000 10 under protanopia
   and deuteranopia in light, and 8 in dark, with the binding constraint named in the failure message.
   **This test does not exist and the current palette would fail it at 1.08 light.** That is the
   point: it must land with the palette, not before it.
6. `muted-2` on `well` and `estimate` on `well` are stated with their measured figure and neither is
   4.50.

### What it explicitly does not do

- It does not add a token. 45 in, 45 out, plus the missing `--mz-info` alias.
- It does not touch `CATEGORY_PRESET_COLORS`. Those 22 hexes are persisted user data, correct as
  literals, and `categoryRamp.test.ts` deliberately keeps them out of the token system.
- It does not move any call site. 1,029 utility occurrences change appearance and zero change code.
  The one exception is the `line-2` re-point in Phase 13, and it is deliberately not here.
- It does not touch the type scale, the radii, the spacing, or any component.
- It does not attempt a light-theme surface step at 3:1. That is arithmetic, and pretending otherwise
  is the claim rule 2 forbids.

---

## Phase 13: the graphic layer, first pass

> **[RE-DERIVED 2026-09-01. Every contrast figure below this line is against a palette that was
> never built, and the conclusion drawn from them is false on the one that was.]**
>
> This section was written before the repalette landed and measures "Bone and Signal", citing a
> script `band.mjs` that does not exist anywhere in the repo. Commit 4a2db38 shipped pure black and
> white instead. Re-derived from the triplets in `index.css` through `tests/helpers/palette.ts`,
> which reads the file live:
>
> | stated below | re-derived 2026-09-01 |
> |---|---|
> | `faint` on paper 3.26 light, 4.10 dark | **3.84 light, 5.17 dark** |
> | `line-2` structural at 3.64 to 4.05 light, 3.99 to 4.56 dark | **2.84 to 3.15 light, 2.72 to 3.77 dark** |
> | `structural = border-line-2` (section boundary, clears 3:1) | **fails 3:1 on rail/light 2.92, well/light 2.84, card-white/dark 2.72** |
> | `line-2` on `rail` measures 1.10:1 in the current light theme | **2.92:1**, measured in a browser off the rendered element |
> | `border-line` 30, `border-line-2` 61, `border-line-3` 23, 114 total | 35 / 63 / 24, **126 total** (ordinary drift, not a defect) |
> | `border-faint` has 0 call sites | still 0, and it is the only figure here that held |
>
> **What the ladder actually is.** Exactly two rule tokens clear 3:1 on all six grounds in both
> themes: `line-3` (min 4.16) and `faint` (min 3.46). `line` is below the floor everywhere, which is
> correct and deliberate for the quiet rung. `ink-soft` clears by a wide margin and is the datum
> rung. So the structural rung is `faint`, the quieter of the two that clear, and NOT `line-2` as
> move 1 declares. `line-3` also clears but is spoken for: it is e3's border in `Card.tsx`, the
> elevation that carries money, and the `closing` double rule under a sum.
>
> `tests/ruleLadder.test.ts` now pins all of this, including the specific refutation that `line-2`
> clears everywhere, so the claim cannot be re-asserted in prose without a test failing.
>
> **What shipped from this phase, and what did not, is recorded at the end of the section.**


**The finding that sets the order.** The graphic-layer plan's rule ladder is written against the
current palette and does not survive the repalette. Its move 1 declares "structural = `border-faint`,
the only rung that clears 3:1", which is true today (`faint` on paper 3.26 light, 4.10 dark) and
**false on Bone and Signal** (`band.mjs`: 2.45 light, 3.06 on card; 5.48 dark). Also `border-faint`
has **0 call sites today**, so it was a new usage rather than a re-point.

After graft 1 this gets better, not worse: **`line-2` becomes the structural rung** at 3.64 to 4.05
light and 3.99 to 4.56 dark against its own surface. That is a cleaner answer than borrowing `faint`,
which `index.css` declares non-text and which should not do double duty as structure. And it is a
re-point rather than a sweep, because the three line tokens already have call sites (`border-line` 30,
`border-line-2` 61, `border-line-3` 23, plus 3 `divide-line`, 114 in total).

**What ships: 5 of the 16 proposed moves.**

1. **The rule ladder, four weights with one meaning each.** `quiet` = `border-line` (item boundary
   inside a list, sub-3:1 on purpose). `structural` = `border-line-2` (section boundary, clears 3:1).
   `closing` = the existing `border-double border-line-3` (a sum is closed). `datum` = the full-width
   `ink-soft` bar, at most one per screen. Declared once in a `Rule` primitive; the 114 existing sites
   are re-pointed against that table.
2. **The NavRail boundary.** Its `border-l` goes to the structural rung. This is the most important
   boundary in the app, chrome against money, and `line-2` on `rail` measures 1.10:1 in the current
   light theme. One class.
3. **The card edge, spent where it is earned.** e2 and e3 get the structural border, e1 stays quiet.
   Raising every card turns six screens into boxes, which is the crowding failure. One table in
   `Card.tsx`, whose docstring the emitter rewrites.
4. **The estimate hatch, generalised to one new region: the Ledger's scheduled half above the Today
   rule.** The 135-degree hatch is the app's one genuinely good graphic idea and it renders in exactly
   one place. The Ledger is the flattest screen (5 chromatic against 40 neutral utilities, 0 cards, 0
   SVG, 1 icon) and the most used. A hatched region says a different kind of thing happened here,
   which is what constraint E requires and which a lighter tint cannot say. One consumer, not four.
5. **The series ramp promoted out of the 10px allocation strip**, positionally only, on Investments.
   It is the only place in the palette where hue actually spreads, it is walled inside one bar on one
   screen, and `seriesColor` plus the fold-to-Other behaviour already exist. This is the largest
   legitimate injection of colour available and it is nearly free. It is also the only move in this
   pass that changes a layout rather than a token, so it is gated on every slice carrying its printed
   percentage and label, and on the ramp never being persisted or shared across views.

**What waits, and why it is not a budget question.** The mark vocabulary, the bracket primitive, the
empty-instrument treatment, the bar graduations, the skeleton geometry, the rhythm steps, the radius
collapse (`rounded` and `rounded-md` are the same 8px; measured `rounded-lg` 54, bare `rounded` 30,
`rounded-full` 19, `rounded-xl` 18, `rounded-md` 17, `rounded-sm` 2), the motion policy, and the icon
freeze all wait. **Four of the five Phase 5c tracks shipped something that fired on an ordinary
healthy event and no test failed.** Each of these moves needs its own healthy-case test, and shipping
eleven at once is how that recurs. They go in a second pass, ordered by which screen is flattest.

### The anti-crowding rules that bound this pass, hard and testable

- **One subject per route.** Exactly one `Figure scale="subject"` per screen. Already true (Instrument
  1, Plan 1, Accounts 1, the other three 0). A test renders each route against the migrated fixture
  and asserts at most 1.
- **The healthy ledger is nearly monochrome, and that is the point.** On the healthy fixture
  (calibrated sheet, zero open review items, zero faults, zero negative figures, zero refusals) a
  screen renders **at most one chromatic semantic family, and it is sage**. Every `clay`, `gold`,
  `review-*` and `estimate` token on screen must trace to a state the code checked. This is rule 3
  applied to colour: a detector must be silent on a healthy event, and so must the palette. Written as
  the healthy-case test, not the detection test.
- **Structural rules are rationed.** At most 6 `border-line-2` occurrences per view file, and zero
  inside any component that renders once per list row. Quiet dividers are unrationed because they are
  sub-3:1 by design and cannot shout.
- **Two textures, zero on a ground.** At most 2 `repeating-linear-gradient` declarations in
  `client/src`, at most 1 `radial-gradient`, and zero gradient or background-image on any element
  whose background token is `paper`, `rail`, `card`, `card-alt` or `card-white`.
- **No gradient on a data-sized element.** A gradient across a bar makes its two ends read as
  different quantities.
- **Every quantitative graphic has a printed number within one line.** A bar with no numeral beside it
  is decoration and fails the test.
- **At most 4 cards per screen**, and Ledger, Investments and Settings stay at 0.
- **At most one full-width `ink-soft` datum rule per screen.** A second one means neither is the datum.
- **The series ramp is positional and never persisted.** Zero occurrences of `series-` in anything
  written to SQLite, localStorage or an export. No two views colour the same entity from the ramp.
- **Nothing in this pass ships without its healthy-case test.** Construct the healthy screen, assert
  silence, then assert detection.

**What proves it worked.** The healthy-screen test renders one chromatic family. The rationing tests
fail on a seventh `border-line-2` in a view file. The four load states still render. Driven in a
browser at 1024 / 1280 / 1440 in both themes, six screens, no console errors and no horizontal
overflow.

**What it does not do.** No icons enter Instrument, Investments, Plan or Accounts (the honest answer
to the icon half of the brief is that an icon on a money row is a second label for something the word
already says, and the NavRail dot experiment is the measured proof). No page-level background,
gradient, noise or texture: every AA figure in `edgeToken.test.ts` is computed against a flat ground,
and a noise layer silently invalidates all of them. No illustration, no mascot, no institution logos,
no donut or radial gauge, no per-entity colour identity, no badge counts, no health ramp anywhere.

---

## Phase 14: the accessibility remainder

**What it changes.** Measured today: `htmlFor` is **0 across 40 `<label>` elements**, `aria-live` is
**0**, `aria-sort` is **0**. This phase closes all three, adds sortable headers on the Ledger, and
adds drill-down from a chart to a filtered ledger.

**Why here, and not earlier.** Not priority. The graphic layer changes what has to be announced. If
the empty-instrument treatment lands after an aria-live sweep, every empty branch needs revisiting; if
the mark vocabulary lands after, every mark needs a text alternative retrofitted. A mark whose
`reason` prop is required is the natural place to source its `aria-label`, and that prop does not
exist until Phase 13's second pass. Doing this before the graphic layer means doing it twice.

The two items that genuinely do not wait (`role="dialog"`, focus restore) were pulled into Phase 12
because they depend on nothing at all.

**What proves it worked.** A test walking `client/src` that asserts every `<label>` either carries
`htmlFor` or wraps its control. A test asserting every dialog has `role`, `aria-modal` and a focus
trap. Driven with the keyboard only, six screens, no trap and no lost focus.

**What it does not do.** It does not add a top bar, a breadcrumb or a separate global search. Cmd+K
answers that, the Advisor tab was deleted on the same argument, and **that decision has never been
written down.** Write it down here: navigation and search live in Cmd+K, one conversational surface,
one keyboard owner, and a surface with nowhere to live means the integration is not finished.

---

## Phase 15: freezing history, and the record

**What it changes.**

- **The Investments account set is frozen at snapshot-write time.** Today it is resolved from the
  current `accounts` table and applied to every past breakdown, so retyping a brokerage to `savings`
  moves two snapshots from $2,445.89 to $505.92 and the screen stays internally consistent while being
  historically false. The honest fix is `snapshot.ts`, a migration, and a backfill. It is here rather
  than in Phase 11 because it makes history wrong-but-consistent, which is a lower grade of error than
  the $1,800 of live ledger error Phase 11 closes.
- **`deriveAssetBuckets` is re-homed or deleted with its test.** Confirmed: the only non-comment
  references are `netWorthHistory.ts` (the definition) and `tests/creditPosition.test.ts`. It has no
  production caller. It survives solely because that test is the last assertion that a card in credit
  carries as a negative liability through that path. Re-home the assertion or delete both, and say
  which.
- **Refused advisor draft rows get a bound.** Nothing bounds the accumulation when the model
  re-proposes a declined category. Dropping the row is the defect that was already fixed, so the bound
  has to be on the rows, not on the pool.
- **The stale `rules.ts` docstring is re-derived.** Lines 502 to 503 say "236 live rules over 41
  distinct timestamps, 173 of them sharing one". Two of those three figures are stale: CLAUDE.md's
  own re-derivation on 2026-07-31 against a copy at migration 054 returns **234 and 41**, with 171
  sharing one. The file whose history is the record of why the `id ASC` tiebreak exists must not carry
  a figure its own query contradicts. Re-run the query, paste the output, print the query beside it.
- **The stale hex inventory item is corrected**, per the census in Phase 12.
- **`CLAUDE.md` and `.claude/plans/ui-overhaul.md` get tracked.** [SETTLED 2026-09-01, both ways.]
  `ui-overhaul.md` was tracked at 906c75e and trimmed to a stub on 2026-09-01, which is the other
  half of Decision 4 below and had not been done: the repo shipped its whole 2026-07-27 Diagnosis
  for a month, describing a palette and a set of defects that no longer existed. `CLAUDE.md` stays
  gitignored, which `relink-and-close.md` records as the owner's explicit decision. The sentence
  below said "Both are currently outside git", and it was already false for `ui-overhaul.md` when it
  was written. What is not acceptable is leaving
  the only record of what a bug cost in one working copy for a third consecutive plan.

**What proves it worked.** The membership freeze: retype an account in a scratch copy and assert the
historical breakdown does not move. The rules docstring: the emitter pattern, one query, output
pasted. The tracking: `git ls-files` returns both paths.

---

## Decisions taken, so they stop being open

**1. Which palette.** Bone and Signal, with the border ladder re-authored to the measured L\* budget,
the money pair re-cut for dichromacy on the sweep in `solve.mjs` section D, its own series ramp kept,
and Verdigris's measurement method (the real `Card.tsx` rung mapping) adopted. The judges'
disagreement resolves against Foolscap on three grounds: it makes the positive/negative money pair
worse than the palette it replaces under deuteranopia in dark (2.39 against 5.50), it concedes in its
own writeup that it does not deliver the brief, and it discards the warm paper the diagnosis
explicitly classed as taste. Judge 1's recommendation to graft Foolscap's series ramp is declined
because it compared Foolscap's CIEDE2000 figures against Bone and Signal's OKLab figures; in the
metric the test actually computes, Bone and Signal's ramp is better on both binding gates and on
tritan.

**2. How the repalette lands.** Five gates: emitter first and proven against today's file, `/alpha`
canary second and proven on the current palette, triplets alone in a mechanical commit, prose
machine-written in a second commit, owner sees it in a browser against a copy of the real database
before either is pushed. The nine rail sites and the two `pill-bg` sites are outputs of this phase,
not inputs, and fixing them first is wasted work.

**3. How much of the graphic layer ships first.** 5 of 16 moves: the rule ladder, the NavRail
boundary, the card edge at e2/e3, the hatch on the Ledger's scheduled half, and the series ramp
promoted on Investments. Everything else waits for its healthy-case test. Bounded by the ten
anti-crowding rules above, all of which are testable and none of which is a review comment.

**4. `.claude/plans/ui-overhaul.md` is trimmed to a stub and folded, not deleted.** Its token,
type-scale, elevation, dark-mode and chart phases shipped under other names in 7b, 8 and 9. Its
Advisor items are moot because Phase 8 deleted the Advisor tab rather than improving it. Its five
genuinely unshipped items move here (Modal `role`/`aria-modal` and focus restore into Phase 12;
`htmlFor`, `aria-live`, `aria-sort`, sortable headers and chart drill-down into Phase 14; the
top-bar/global-search question answered in Phase 14). What stays in the file is the `/alpha`
diagnosis, and it stays because it is **load-bearing evidence for Gate 1, not history**: three
auditors independently compiled the real config to establish that `withAlphaValue` drops the utility
silently, and that measurement is the reason the canary exists. Deleting the file destroys the only
copy of it, since the file is untracked. Trim it to that plus a pointer here, and track it.

**5. Where accessibility sits.** Phase 14, after the graphic layer, because the graphic layer changes
what has to be announced and doing it first means doing it twice. Two items are pulled forward into
Phase 12 because they depend on nothing: `role="dialog"` with `aria-modal`, and focus restore on
dialog close.

**6. `ai_observations` and `ai_briefs` are formally dropped.** Verified: **zero references in
`server/`, `client/`, `shared/` or `tests/`.** They appear only at `rebuild.md:184` and
`rebuild-part-2.md:338`, where they were deferred to 6.3 and then never built when 6.3 landed. The
reason to drop rather than build is structural. `ai_observations` was a store for standing notes about
the ledger; `ai_memory` exists and does that. `ai_briefs` was a store for periodic written summaries;
the digest exists, is generated on demand, and renders in Cmd+K. Building either now creates a second
store for a thing that already has one, which is the four-hand-maintained-copies failure
`DRAFT_KIND_AUTONOMY` exists to prevent. There is also a rule 3 argument: a briefs table is a standing
artifact, rows accumulate, and the owner cannot act on a brief from three weeks ago. This plan already
carries one unbounded-accumulation defect of exactly that shape (refused draft rows), and adding a
second before the first is bounded is not a trade worth making.

**What the drop costs, stated so it is not rediscovered as a surprise:** there is no durable record of
what the model *noticed* on a given run. `advisor_actions` records what it did. A question like "when
did it first think the brokerage was being drained" is unanswerable. If that question is ever asked in
earnest, the answer is a provenance column on `ai_memory`, not a second table.

---

## Sequencing risk, honestly

**The nine rail sites fold into the repalette, they do not fight it.** All four tones clear AA on the
new rail. Fixing them first is work the repalette makes meaningless, in the same files.

**The hardcoded hex is not a sequencing question because it no longer exists.** `#c9963a` survives
only as a comment recording the defect. The inventory item is stale.

**The real collision runs the other way from the obvious guess.** It is not palette against
accessibility or palette against correctness. It is **palette against the graphic layer**, and it is a
hard dependency: the graphic layer's structural rung is defined in terms of the palette
(`border-faint` clears 3:1 today and does not on the new one), so the graphic layer cannot lead, and
the rule ladder has to be re-derived rather than transcribed.

**The second collision is the emitter against the prose.** The repalette rewrites 70 figures across 14
files. The graphic layer rewrites `Card.tsx`'s ladder table and `NavRail.tsx`'s ratio sentences, which
are among those 70. If the graphic layer lands before the emitter is trusted, those figures get
hand-edited twice, and hand-editing them is the exact mechanism that produced the stale `tan 0.041`
claim.

**Phase 11 is genuinely parallel to all of it.** Server services and a migration against
`client/src/index.css` and tests. Zero file overlap. If the owner wants to see the redesign first,
that is a free reorder and the only one in this plan.

**The one risk this plan cannot design away.** A palette is the change where the full suite passing
and the screen being wrong are completely compatible. Phase 9 shipped a selection ring that measured
correctly and rendered at 1.97:1 because `opacity-55` composited it, and `opacity` applies to
`box-shadow`. No test in this repo can see a composite. Gate 4 is not a formality.

---

## Out of scope, deliberately

All the standing non-goals hold and none of them is reopened by this plan: sub-500px layouts,
multi-user or auth, re-adding Plaid or Teller, a score out of 100 or any grade-implying colour scheme,
and rewriting a number an institution reported (Phase 11 *records* a disagreement, it does not
silently resolve one; that distinction is the whole design of migration 048).

Two more, specific to this plan:

- **No new colour tokens.** 45 in, 45 out. The complaint is that 45 tokens produce two and a half
  perceptible hues, and the fix is separation, not count.
- **No page-level background treatment, ever.** Every AA figure in the suite is computed against a
  flat ground. A texture behind a money numeral invalidates all of them silently, which is the same
  failure mode as the `/alpha` bug: correct in the tokens, wrong on the screen, and no test can see it.
---

## Outcome, 2026-09-01: Phase 13 closed, Phase 14 half closed

Written after the work, against the palette that shipped. Every figure below was re-derived on the
date of writing; where it contradicts a figure earlier in this file, the earlier one was measured
against **Bone and Signal**, the candidate palette commit 4a2db38 did not build.

### What shipped

**The healthy-colour rule, which this phase called the point, is now a test.** `healthyColour.test.ts`
constructs the fixture this file specifies (calibrated sheet, empty review queues, no faults, no
negative figures) and asserts the instrument renders no `clay`, `gold`, `estimate` or `review-*`
token at all. It asserts the fixture is healthy FIRST, through `readCalibration` rather than by
restating its four conditions, because a fixture that is quietly stale renders gold correctly and
the silence assertion then measures nothing. The first draft did exactly that: it reused the shipped
fixture, whose sheet is dated 2026-07-30, and failed on a screen that was right.

Writing it found one real defect. `<Figure tone="negative" label="Out">` was the only unconditional
chromatic tone in the client. It painted total spending in the alarm colour every window, so on the
screen where clay also marks a short sheet, clay carried no information. This file's own argument
against icons covers it exactly: a second label for what the word already says. The clay was also
wrong on data, because `summary.expenses.current` sums the signed `spendAmountSql` = `(-t.amount)`:
driving `getReportSummary` over all 156 Monday-anchored weeks the ledger covers, **2 come back
negative**, the week of 2026-07-13 at Out −1,313.17 against In 544.18. Both figures are neutral ink
now with `value`/`states` carrying the sign, and `net` keeps its tone, so the block has exactly one
coloured figure and it is the one whose sign varies. `graphicRestraint.test.ts` pins the general
form across all six screens, since only the instrument has a render harness.

**The rule ladder was re-derived, and my own re-derivation was wrong too.** An adversarial pass found
`ruleLadder.test.ts`'s ground set wrong in both directions: it carried `card-white`, which has **0**
`bg-card-white` call sites and which `Card.tsx` already calls "not a rung", and it omitted `track`,
the darkest ground, painted **12** times. The set is derived from source now.

| | light | dark |
|---|---|---|
| `line-2` fails on | rail 2.92, well 2.84, track 2.39 | track 2.44 |
| `faint` fails on | track 2.91 | none |
| `line-3` fails on | none | none |

So "exactly two tokens clear on every ground" was an artefact: only `line-3` clears everywhere. But
min-across-grounds is the wrong question. Asked directly, per element, **twelve** pairings drew
`line-2` on `rail` or `well` and missed the floor. The rail's own left boundary was corrected
earlier and the divider above Settings was missed, same token, same ground.

**Commit c304b21 said nine, fixed nine, and that number was itself a measurement artefact.** Its
walker found tags with `/<[A-Za-z][^>]*>/g`, and `[^>]*` stops at the first `>` in the source, which
in this codebase is routinely the `>` of an arrow-function prop. Two of the three it missed are the
`<textarea>` and `<input>` in Settings whose `onChange={(e) => ...}` sits above their `className`,
so the class list was never read. The third, `DataSection.tsx:623`, inherits `bg-rail` from a block
opened 45 lines earlier, which a same-tag check cannot see at all. All twelve are fixed now.

The walker is `tests/helpers/jsx.ts`, shared by the three tests that had each written their own copy
of that regex. It tracks brace depth, string and template state, and comments inside a tag, and it
carries a **coverage assertion**: every rule utility in `client/src` outside comment prose must sit
inside a tag it extracted, resolve its own ground on the same line, or be named with the figure that
clears it. Two are named. The pairing check also counts the 21 utilities whose ground it cannot
resolve in-file and prints that number rather than passing them, because a ground nobody resolved is
not a clean pairing.

**Phase 14's drill-down shipped.** A category figure on `/` opens the rows it is made of. The whole
stack already filtered by category and only the deep link was missing. `six-months` was added to the
ledger's ranges rather than mapped onto `three-months`, because a drill-down that narrows the window
shows a subset of what the figure sums. Verified rather than assumed: over the whole ledger, every
category's report figure equals the sum of the rows the link opens, to the cent.

### What did not ship, and why

**Move 3, cards.** Superseded. `Card.tsx` already carries a reasoned e1-on-`line-2` ladder that
post-dates this plan, and `cardElevation.test.ts:121-143` is a property loop asserting every rung
clears 3:1 against its own surface. A demoted e1 measures 1.30 light. The move requires deleting a
landed invariant, not rewriting a docstring. Confirmed by two independent refuters.

**Move 4, the ledger hatch.** Not shipped, and my first reason for it was the weak one. I argued
redundancy, that `Ledger.tsx`'s today rule and the estimate ink already say it twice. The stronger
reason, which survived refutation: `HATCH` is gated on `calibrated ? undefined : HATCH`, so it is
the app's one **fault** mark, and a scheduled row is a healthy state. Using it here is rule 3 read
backwards. Also worth recording: I believed `graphicRestraint.test.ts` would catch this move, and
that was refuted. It exempts `well` by name and its per-tag check passes a transparent wrapper, so
move 4 would have broken no test.

**Move 5, the series ramp.** Not shipped, and **my stated reason was false.** I recorded that the
ramp was "already outside the strip". It is not: `Investments.tsx:446-450` still renders the 10px
stacked `overflow-hidden` strip with each slice filled from `s.color`, and the 9px swatches beside
the labels are a second surface, not a replacement. The move is undone, not done. It should stay
undone for a different reason: the ramp's separation guarantee is adjacent-pair only, worst
all-pairs CVD distance is dE 0.5, and `seriesPalette.test.ts:19-22` already records that eight slots
cannot clear all-pairs.

**Move 1, a full re-point.** Not taken as written. Re-pointing ~200 sites was not the fix; nine
mis-paired sites were.

### Left open

- **Sortable headers, `aria-sort`.** The remaining half of Phase 14, and it should not be built as
  written. The ledger has **no column headers**: it is a day-grouped list on a date spine whose
  today rule is the only thing separating what is expected from what happened. Sorting by amount
  destroys the spine and makes that rule meaningless. If the underlying want is "my biggest
  entries", that is a different surface, not a header on this one.

  Separately: `sortBy` and `sortDir` are plumbed through `TransactionFilters`, the query schema, the
  service and `transactionsApi.list`, and **no screen passes either**. The only occurrences in
  `client/src` are the two lines in `api.ts` that append them. By this repo's own rule that is a
  dropped capability rather than dead code, one layer below a fetcher with no caller: the parameter
  exists, the server honours it, and nothing can ask. Whoever settles the sorting question should
  decide whether that plumbing is the beginning of a feature or a leftover to remove.
- **Finding 9**, the palette question, still a design commitment rather than a defect.
- **Gate 4 coverage.** The healthy-colour rule is verified by rendering on **one screen of six**.
  The directional clay on Investments, Plan and Accounts is conditional on a measured state and so
  falls under this file's own carve-out, but nothing asserts it.
