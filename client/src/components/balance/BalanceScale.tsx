import type { ReactNode } from 'react';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import { formatCurrency } from '../../lib/formatters';
import { useSettledValue } from '../../lib/useSettledValue';

/**
 * The full swing of the reading, in degrees, kept because it is the domain every other figure
 * here is derived from: -9 is owing everything, 0 is level, +9 is holding everything.
 */
const MAX_TILT_DEG = 9;

/**
 * Degrees the beam tilts for a given balance sheet. Positive dips the assets pan.
 *
 * Linear in debt's share of the whole sheet across the entire domain: no debt tips fully one
 * way, owing as much as you hold sits level, and every state in between is distinguishable.
 *
 * `owed` is non-negative by construction: the caller puts a credit position on the assets pan,
 * where it belongs, rather than handing this a negative debt to interpret.
 */
export function beamTiltDegrees(assets: number, owed: number): number {
  const total = assets + owed;
  if (total <= 0) return 0;
  return MAX_TILT_DEG * (1 - 2 * (owed / total));
}

/**
 * The same reading, expressed where a person can measure it: the fraction of the whole sheet
 * that is held, with 0.5 the point where held equals owed.
 *
 * This exists because the rotation could not be read. A drawn beam mapped the whole 18-degree
 * domain onto the vertical travel of a beam end, 2 x 104 x sin(9 deg) at the scale it rendered,
 * which is 33.76px end to end; `tests/accountBalanceView.test.ts` recomputes that geometry rather
 * than trusting this sentence. A real series uses almost none of that domain, so a real series
 * moved almost nothing.
 *
 * Two windows on the owner's own ledger, both measured 2026-07-31 against a copy of
 * .mizan/mizan.db at migration 046, both stated because they are the ones a reader would confuse:
 *
 *   the 19 sheets Today hands this axis    2026-02-01 to 2026-07-29, six months   4.600 deg  8.66px
 *   the 14 measured ones among them        2026-06-30 to 2026-07-29, one month    2.724 deg  5.13px
 *
 * The same 2.724 degrees mapped onto the width of its container is 181px of the 1196px beam a
 * 1440px window gives it. That is a distance on a labelled axis. 5.13px of pan travel is a mood.
 *
 *   SELECT date, is_estimated, total_assets, total_liabilities
 *   FROM net_worth_snapshots ORDER BY date;
 *
 * Derived from `beamTiltDegrees` rather than recomputed so the two cannot drift apart.
 */
export function beamPositionFraction(held: number, owed: number): number {
  return beamTiltDegrees(held, owed) / (2 * MAX_TILT_DEG) + 0.5;
}

export interface ScalePans {
  held: number;
  owed: number;
  /** How much of `held` is a liability in credit rather than an asset, for the label to name. */
  credit: number;
}

/**
 * Which side of the boundary each part of the sheet belongs on.
 *
 * A negative liability total is a net credit: the cards owe the owner. That is weight on the
 * HELD side, not debt of the same size, and `Math.abs()` put it on the wrong side, so a sheet
 * that was better than debt-free read as one carrying debt. `held - owed` stays equal to net
 * worth either way, which is the property that keeps the instrument honest against the figures
 * printed beside it.
 */
export function scalePans(assets: number, liabilities: number): ScalePans {
  const credit = Math.max(0, -liabilities);
  return { held: assets + credit, owed: Math.max(0, liabilities), credit };
}

/* ── What the instrument can and cannot vouch for ──────────────────────────── */

/**
 * A reason this reading is not a measurement of the sheet as it stands today.
 *
 * Each one is a condition the code checks against data it holds, never an inference. There is no
 * severity ranking and no score: any single fault takes the whole face out of calibration,
 * because a reading you have to qualify is not a reading you can take at a glance.
 */
export type CalibrationFault =
  | { kind: 'no_sheet' }
  | { kind: 'estimated' }
  | { kind: 'coverage'; covered: number; total: number }
  | { kind: 'stale'; asOf: string; days: number }
  | { kind: 'sync_incomplete' };

export interface Calibration {
  calibrated: boolean;
  faults: CalibrationFault[];
}

export interface CalibrationInput {
  /** `yyyy-MM-dd` of the balance sheet being read, or null when none has been recorded. */
  sheetDate: string | null;
  /** Today's local `yyyy-MM-dd`. Supplied rather than read, so the function stays pure. */
  today: string;
  isEstimated: boolean;
  /** NULL on rows written before migration 044, which is why this is not defaulted to the total. */
  coveredAccounts: number | null;
  totalAccounts: number | null;
  /** The last sync did not finish every stage. A partial run commits some provider writes. */
  syncIncomplete: boolean;
}

export function readCalibration(input: CalibrationInput): Calibration {
  const faults: CalibrationFault[] = [];

  if (input.sheetDate === null) {
    faults.push({ kind: 'no_sheet' });
  } else {
    if (input.isEstimated) faults.push({ kind: 'estimated' });
    if (
      input.coveredAccounts !== null &&
      input.totalAccounts !== null &&
      input.coveredAccounts < input.totalAccounts
    ) {
      faults.push({
        kind: 'coverage',
        covered: input.coveredAccounts,
        total: input.totalAccounts,
      });
    }
    const days = differenceInCalendarDays(parseISO(input.today), parseISO(input.sheetDate));
    if (days >= 1) faults.push({ kind: 'stale', asOf: input.sheetDate, days });
  }

  if (input.syncIncomplete) faults.push({ kind: 'sync_incomplete' });

  return { calibrated: faults.length === 0, faults };
}

/** One clause per fault, each stating only what the check established. */
export function calibrationNote(fault: CalibrationFault): string {
  switch (fault.kind) {
    case 'no_sheet':
      return 'No balance sheet has been recorded yet.';
    case 'estimated':
      return 'This sheet is replayed from the ledger, not measured.';
    case 'coverage':
      return `This sheet reached ${fault.covered} of ${fault.total} accounts.`;
    case 'stale':
      return `Recorded ${fault.days === 1 ? 'a day' : `${fault.days} days`} ago, on ${formatSheetDate(fault.asOf)}.`;
    case 'sync_incomplete':
      return 'The last sync did not finish every stage.';
  }
}

function formatSheetDate(date: string): string {
  try {
    return format(parseISO(date), 'd MMMM');
  } catch {
    return date;
  }
}

/* ── History along the same axis ───────────────────────────────────────────── */

export interface BeamHistoryPoint {
  date: string;
  assets: number;
  /** Signed, the way the snapshot stores it. */
  liabilities: number;
  isEstimated: boolean;
  coveredAccounts: number | null;
  totalAccounts: number | null;
}

export interface BeamHistory {
  marks: Array<{ date: string; fraction: number }>;
  /** Recorded sheets left off because they are not comparable to the current reading. */
  excluded: number;
}

/**
 * Prior readings that can honestly be put on the same axis as this one.
 *
 * A snapshot that reached 11 accounts and one that reached 14 sit at positions whose difference
 * is partly accounts arriving in mizān rather than money moving, so plotting them together draws
 * a change that did not happen. Comparability is therefore exact-match on the coverage pair, and
 * an estimated sheet is never comparable to a measured one at all. Everything refused is counted
 * rather than dropped silently, because "no history" and "history you may not compare" are
 * different states.
 */
export function comparableHistory(
  points: BeamHistoryPoint[],
  reference: { coveredAccounts: number | null; totalAccounts: number | null }
): BeamHistory {
  const marks: BeamHistory['marks'] = [];
  let excluded = 0;

  for (const point of points) {
    const comparable =
      !point.isEstimated &&
      reference.coveredAccounts !== null &&
      reference.totalAccounts !== null &&
      point.coveredAccounts === reference.coveredAccounts &&
      point.totalAccounts === reference.totalAccounts;

    if (!comparable) {
      excluded += 1;
      continue;
    }
    const { held, owed } = scalePans(point.assets, point.liabilities);
    marks.push({ date: point.date, fraction: beamPositionFraction(held, owed) });
  }

  return { marks, excluded };
}

/* ── What the caption says, decided apart from how it is drawn ─────────────── */

/** A run of caption text. `numeral` marks the parts that are set in tabular mono. */
export interface CaptionSegment {
  text: string;
  numeral?: boolean;
}

export interface ReadingCaption {
  /**
   * Why the reading cannot be taken at face value.
   *
   * Its own block, ahead of the reading, because a qualification that arrives after the number has
   * been believed is too late. These used to be siblings of the reading, the credit note and the
   * history summary inside one run-on paragraph, where "this sheet is replayed from the ledger,
   * not measured" sat between a percentage and a count of earlier sheets.
   */
  faults: string[];
  /** The measurement. Null when no sheet exists, so there is nothing to measure. */
  reading: CaptionSegment[] | null;
  /** What the reading does not say on its own. Never a qualification of it. */
  notes: CaptionSegment[][];
}

export function captionText(segments: CaptionSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

export interface ReadingCaptionInput {
  held: number;
  owed: number;
  credit: number;
  calibration: Calibration;
  history: BeamHistory;
}

/**
 * Everything the figcaption states, as data, so what it claims can be tested without a DOM.
 *
 * The `no_sheet` branch is the reason this is a function. `GET /api/networth/snapshot` returns
 * null when nothing has ever been recorded, so the caller has no assets and no liabilities to
 * pass and passes zeros. The caption then read `held + owed <= 0` and printed "Nothing on either
 * side of the sheet yet", which asserts a fact about the owner's balance sheet where the code had
 * only established that no sheet was recorded. The one fault built for that state was the one
 * state that could never print it. The same swallowing hid every fault on a genuinely zero sheet:
 * two months stale, or written by a sync that did not finish.
 */
export function describeReading(input: ReadingCaptionInput): ReadingCaption {
  const { held, owed, credit, calibration, history } = input;
  const faults = calibration.faults.map(calibrationNote);

  // Not ranked as worse than the others; a different kind of statement. The rest qualify a reading
  // that exists. This one says there is no reading, so nothing downstream of one is computed from
  // the zeros that stood in for a sheet.
  if (calibration.faults.some((fault) => fault.kind === 'no_sheet')) {
    return { faults, reading: null, notes: [] };
  }

  if (held + owed <= 0) {
    // A recorded sheet that really is zero on both sides. It is still a sheet, so its faults still
    // apply and are still printed above this.
    return { faults, reading: [{ text: 'Nothing is recorded on either side of this sheet.' }], notes: [] };
  }

  const readingPct = beamPositionFraction(held, owed) * 100;
  const pointsFromEven = readingPct - 50;
  const reading: CaptionSegment[] =
    owed === 0
      ? [
          /* The needle pins to the end of the axis for every debt-free sheet, so the ratio stops
             distinguishing them and the magnitude beside it has to. */
          { text: 'Nothing is owed against ' },
          { text: formatCurrency(held), numeral: true },
          { text: ' held.' },
        ]
      : [
          { text: readingPct.toFixed(1), numeral: true },
          { text: '% of the sheet is held, ' },
          { text: Math.abs(pointsFromEven).toFixed(1), numeral: true },
          { text: ` points ${pointsFromEven < 0 ? 'short of' : 'clear of'} even.` },
        ];

  const notes: CaptionSegment[][] = [];
  if (credit > 0) {
    // "credit the cards owe you" was a stronger claim than anything here checks. `scalePans`
    // derives this from the signed liabilities TOTAL, which a mortgage in credit would satisfy
    // just as well as a card. Today's `readCardCredit` filters `type === 'credit'` precisely so
    // the word "card" stays accurate, and passes what it found in as `owedNote`.
    notes.push([
      { text: formatCurrency(credit), numeral: true },
      { text: ' of what is held is credit on the liabilities side rather than an asset.' },
    ]);
  }
  if (history.marks.length > 0) {
    notes.push([
      { text: String(history.marks.length), numeral: true },
      { text: ` earlier ${history.marks.length === 1 ? 'sheet is' : 'sheets are'} drawn above.` },
    ]);
  }
  if (history.excluded > 0) {
    notes.push([
      { text: String(history.excluded), numeral: true },
      {
        text: ` ${history.excluded === 1 ? 'is' : 'are'} left off: recorded against a different` +
          ' number of accounts, or replayed rather than measured.',
      },
    ]);
  }

  return { faults, reading, notes };
}

/* ── The instrument ────────────────────────────────────────────────────────── */

const GRADUATIONS = [0, 10, 20, 30, 40, 60, 70, 80, 90, 100];

interface BalanceScaleProps {
  assets: number;
  /** Amount owed. Negative means the liabilities are in credit and owe the owner. */
  liabilities: number;
  calibration: Calibration;
  history: BeamHistory;
  /**
   * A reading the owed side carries that the total cannot: three cards in credit and two in debt
   * sum to an ordinary positive balance, so the credit disappears into the total.
   */
  owedNote?: ReactNode;
  className?: string;
}

/**
 * The signature figure: a calibrated beam carrying what is held against what is owed.
 *
 * The fulcrum is a fixed tick at the halfway point and never moves; the needle sits at the real
 * boundary between the two sides of the sheet; the distance between them is the reading. Neither
 * side is tinted good or bad. A real balance does not colour-code its arms, which is what makes
 * the comparison worth trusting, and debt is a state rather than a verdict. The one colour on the
 * face means "do not trust this reading yet".
 */
export function BalanceScale({
  assets,
  liabilities,
  calibration,
  history,
  owedNote,
  className = '',
}: BalanceScaleProps) {
  const { held, owed, credit } = scalePans(assets, liabilities);
  const empty = held + owed <= 0;

  const target = beamPositionFraction(held, owed);
  // Starts level and settles into the reading, the way a beam finds equilibrium. The text below
  // reads the exact value, never the animated one: a figure that counts up is not a measurement.
  const settled = 0.5 + useSettledValue(target - 0.5);
  const needlePct = clampPercent(settled);

  const caption = describeReading({ held, owed, credit, calibration, history });
  // The face and the words answer two different questions, so they are allowed to differ on one
  // sheet: a fully covered measurement of zero has nothing to qualify (no faults, no gold label)
  // and still nothing to draw, so the well stays hatched to say the axis is empty rather than
  // level. Everything else moves the two together.
  const calibrated = calibration.calibrated && !empty;
  // Jade when the reading can be vouched for, estimate ink when it cannot. The fill was `ink`,
  // which is correct and says nothing: the primary reading on the primary screen was the same black
  // as the body text around it. `sage` measures 3.84:1 on `paper` and 3.00:1 on `track` in light,
  // 5.29 and 4.03 in dark, so it clears the 3:1 a filled UI component owes on every ground the beam
  // is drawn against. The needle follows the fill so the two never disagree about calibration.
  const fillClass = calibrated ? 'bg-sage' : 'bg-estimate';
  const needleClass = calibrated ? 'bg-sage' : 'bg-estimate';

  return (
    <figure className={className}>
      <div className="flex items-end justify-between gap-6">
        <div>
          <div className="text-rule uppercase tracking-[0.16em] text-muted">Held</div>
          <div className="font-mono text-figure leading-[1.25] tabular-nums text-ink">
            {formatCurrency(held)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-rule uppercase tracking-[0.16em] text-muted">Owed</div>
          <div className="font-mono text-figure leading-[1.25] tabular-nums text-ink">
            {formatCurrency(owed)}
          </div>
          {owedNote && <div className="mt-0.5 text-note text-muted">{owedNote}</div>}
        </div>
      </div>

      {/* Everything below is one graphic. The reading is stated in words underneath it, so a
          screen reader gets the measurement rather than a described picture of one. */}
      <div className="mt-4" aria-hidden>
        {/* Where this instrument has sat before, on the same axis, at the same coverage. */}
        <div className="relative h-2.5">
          {history.marks.map((mark) => (
            <span
              key={mark.date}
              className="absolute bottom-0 h-[7px] w-px bg-muted-2"
              style={{ left: `${clampPercent(mark.fraction)}%` }}
            />
          ))}
        </div>

        <div className="relative h-[26px]">
          {/* End stops, so the track reads as a graduated rule rather than a filled bar. */}
          <span className="absolute -top-1 bottom-[-4px] left-0 w-px bg-ink-soft" />
          <span className="absolute -top-1 bottom-[-4px] right-0 w-px bg-ink-soft" />

          <div
            className="absolute inset-0 rounded-[2px] bg-well"
            style={calibrated ? undefined : HATCH}
          />
          {!empty && (
            <div
              className={`absolute inset-y-0 left-0 rounded-l-[2px] ${fillClass}`}
              style={{ width: `${needlePct}%` }}
            />
          )}
          {!empty && (
            /* 2px of surface either side, so the two sides of the sheet never touch. */
            <div
              className={`absolute -top-[7px] -bottom-[7px] w-[7px] -translate-x-1/2 border-x-2 border-paper ${needleClass}`}
              style={{ left: `${needlePct}%` }}
            />
          )}
        </div>

        <div className="relative mt-2 h-[26px]">
          {GRADUATIONS.map((g) => (
            <span key={g} className="absolute top-0 h-[4px] w-px bg-line-3" style={{ left: `${g}%` }} />
          ))}

          {/* The span from even to the reading: the measurement, drawn as a distance. */}
          {!empty && (
            <span
              className={`absolute top-0 h-px ${calibrated ? 'bg-ink-soft' : 'bg-estimate'}`}
              style={{
                left: `${Math.min(50, needlePct)}%`,
                width: `${Math.abs(needlePct - 50)}%`,
              }}
            />
          )}

          {/* The fulcrum. Fixed at the halfway point, in every state, forever. */}
          <span className="absolute top-0 -translate-x-1/2" style={{ left: '50%' }}>
            <span className="block h-0 w-0 border-x-[5px] border-b-[7px] border-x-transparent border-b-ink" />
          </span>
          <span
            className="absolute top-[11px] -translate-x-1/2 whitespace-nowrap text-rule uppercase tracking-[0.16em] text-muted"
            style={{ left: '50%' }}
          >
            Even
          </span>
        </div>
      </div>

      {/* Three registers, in the order they have to be read: what the instrument cannot vouch for,
          then the reading, then what the reading does not cover. They were one paragraph. */}
      <figcaption className="mt-1 space-y-1 text-note text-muted">
        {caption.faults.length > 0 && (
          <div className="flex gap-2">
            <span className="mt-px flex-shrink-0 font-mono text-rule uppercase tracking-[0.16em] text-gold">
              Uncalibrated
            </span>
            <span className="min-w-0">
              {caption.faults.map((note) => (
                <span key={note}>{note} </span>
              ))}
            </span>
          </div>
        )}

        {caption.reading && (
          <div className="text-ink-soft">
            {caption.reading.map((segment, index) => (
              <span key={index} className={segment.numeral ? 'font-mono tabular-nums' : undefined}>
                {segment.text}
              </span>
            ))}
          </div>
        )}

        {caption.notes.length > 0 && (
          <div>
            {caption.notes.map((note) => (
              <span key={captionText(note)}>
                {note.map((segment, index) => (
                  <span key={index} className={segment.numeral ? 'font-mono tabular-nums' : undefined}>
                    {segment.text}
                  </span>
                ))}{' '}
              </span>
            ))}
          </div>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * The settle overshoots on its first swing, which is right for a beam and would put a CSS
 * percentage outside its track.
 *
 * `useSettledValue` eases with 1 - e^(-7t)cos(8t), which peaks at 1.090340 at t = 0.3028, so the
 * overshoot is 9.03%, not the 6% that had been asserted here. A reading already at 96% of the axis
 * would be driven past 100 without this.
 *
 *   node -e "let p=0;for(let i=0;i<=1e6;i++){const t=i/1e6,v=1-Math.exp(-7*t)*Math.cos(8*t);
 *            if(v>p)p=v}console.log(p)"
 */
function clampPercent(fraction: number): number {
  return Math.min(100, Math.max(0, fraction * 100));
}

/**
 * Composed from the channel triplet rather than the flat token, because an alpha needs channels.
 * See the header comment in index.css: a bare `var(--mz-estimate)` cannot take one.
 */
const HATCH = {
  backgroundImage:
    'repeating-linear-gradient(135deg, rgb(var(--mz-estimate-c) / 0.22) 0 2px, transparent 2px 6px)',
} as const;
