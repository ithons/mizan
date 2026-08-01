import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { askAdvisor, isAdvisorAsk, ASK_EVENT } from '../client/src/lib/askAdvisor';

/**
 * The ⌘K sheet: what a screen may hand it, and what a money numeral lands on inside it.
 *
 * The sheet is now the only conversational surface in the app, so every figure the model prints and
 * every figure the owner types lands here. The grounds are read out of the two source files rather
 * than assumed, because the failure this guards against is somebody adding a fill and not thinking
 * about what sits on it.
 */

const ROOT = join(import.meta.dirname, '..');
const CSS = readFileSync(join(ROOT, 'client/src/index.css'), 'utf8');
const SOURCES = ['client/src/components/CommandPalette.tsx', 'client/src/components/AskPanel.tsx'].map(
  (file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') })
);

type Rgb = readonly [number, number, number];

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => alpha * fg[i] + (1 - alpha) * bg[i]) as unknown as Rgb;
}

function triplet(name: string, theme: 'light' | 'dark'): Rgb {
  const matches = [...CSS.matchAll(new RegExp(`--mz-${name}-c:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, 'g'))];
  assert.ok(matches.length > 0, `--mz-${name}-c is not declared in index.css`);
  const m = theme === 'light' ? matches[0] : matches[matches.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe('what a screen may hand the sheet', () => {
  test('a payload with a source and a question is accepted', () => {
    assert.equal(isAdvisorAsk({ source: 'sync', prompt: 'Why did this run fail?' }), true);
    assert.equal(isAdvisorAsk({ source: 'import', prompt: 'x', recordKind: 'run', recordId: '7' }), true);
  });

  test('a payload with nothing to ask is refused rather than opening an empty sheet', () => {
    assert.equal(isAdvisorAsk(null), false);
    assert.equal(isAdvisorAsk({}), false);
    assert.equal(isAdvisorAsk({ source: 'sync', prompt: '   ' }), false);
    assert.equal(isAdvisorAsk({ prompt: 'no source' }), false);
  });

  test('askAdvisor dispatches the question, and drops one it cannot ask', (t) => {
    // The module dispatches on `window`, which node:test does not define. An EventTarget standing
    // in for it is enough to prove the payload reaches a listener and that a blank one does not.
    const global = globalThis as { window?: EventTarget };
    const previous = global.window;
    global.window = new EventTarget();
    t.after(() => {
      global.window = previous;
    });

    const seen: unknown[] = [];
    global.window.addEventListener(ASK_EVENT, (event) => seen.push((event as CustomEvent<unknown>).detail));

    askAdvisor({ source: 'sync', prompt: 'Why did this run fail?' });
    askAdvisor({ source: 'sync', prompt: '  ' });

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { source: 'sync', prompt: 'Why did this run fail?' });
  });
});

describe('the grounds a money numeral lands on in the sheet', () => {
  const AA = 4.5;

  /**
   * Every fill the sheet paints, and what a numeral can sit on it.
   *
   * Read out of the source below, so a new fill fails this list rather than shipping unmeasured.
   *   card       the sheet itself: the digest's amounts, the model's prose, a draft's before/after
   *   well       the active command row and the revert offer
   *   well/60    a draft row on hover
   *   card-alt   the conversation history menu
   *   rail       the owner's own message, and a code span inside the model's answer
   *   ink        the two filled buttons, which carry `text-paper` and no figure
   *   ink/10     the scrim, which carries nothing and is light enough to read the screen through
   *   sage       the 7px caret and composer mark, which carry no text at all
   */
  const GROUNDS = new Set([
    'card', 'card-alt', 'well', 'well/60', 'rail', 'ink', 'ink/10', 'sage', 'transparent',
  ]);

  test('the sheet paints no fill that has not been measured', () => {
    for (const { file, text } of SOURCES) {
      for (const [, token] of text.matchAll(/\bbg-([a-z0-9/-]+)/g)) {
        assert.ok(GROUNDS.has(token), `${file} paints bg-${token}, which is not in the measured set`);
      }
    }
  });

  // Grounds that actually carry a figure, and every ink the sheet pairs with them.
  const TEXT_GROUNDS: ReadonlyArray<{ ground: string; alpha?: number; over?: string; tones: string[] }> = [
    { ground: 'card', tones: ['ink', 'ink-soft', 'muted'] },
    { ground: 'well', tones: ['ink', 'ink-soft', 'muted'] },
    { ground: 'well', alpha: 0.6, over: 'card', tones: ['ink', 'ink-soft', 'muted'] },
    { ground: 'card-alt', tones: ['ink', 'muted'] },
    { ground: 'rail', tones: ['ink', 'muted'] },
  ];

  for (const theme of ['light', 'dark'] as const) {
    for (const { ground, alpha, over, tones } of TEXT_GROUNDS) {
      const name = alpha ? `${ground}/${alpha * 100} over ${over}` : ground;
      const surface = alpha && over ? composite(triplet(ground, theme), alpha, triplet(over, theme)) : triplet(ground, theme);
      for (const tone of tones) {
        test(`${tone} on ${name}, ${theme}`, () => {
          const ratio = contrast(triplet(tone, theme), surface);
          assert.ok(ratio >= AA, `${ratio.toFixed(2)}:1 is below AA ${AA}:1`);
        });
      }
    }
  }

  test('the transcript ground measures what AskPanel says it measures', () => {
    // AskPanel's PROSE comment states these two figures; they are re-derived rather than trusted.
    assert.equal(contrast(triplet('ink', 'light'), triplet('card', 'light')).toFixed(2), '21.00');
    assert.equal(contrast(triplet('ink', 'dark'), triplet('card', 'dark')).toFixed(2), '19.03');
    assert.match(SOURCES[1].text, /21\.00:1 light and 19\.03:1 dark/);
  });

  test('the one text colour that is under AA on the lightest ground stays out of the sheet', () => {
    // `faint` is deliberately below AA and deliberately non-text. Re-derived on `paper`, the
    // lightest ground it could land on: 3.84:1 light, 5.17:1 dark. It clears on dark now, so the
    // claim is the light one plus the token's own contract, not a blanket "not AA anywhere".
    assert.ok(contrast(triplet('faint', 'light'), triplet('paper', 'light')) < AA);
    for (const { file, text } of SOURCES) {
      assert.ok(!text.includes('text-faint'), `${file} puts text on the faint token`);
    }
  });

  test('the filled buttons carry the ink that was measured against them', () => {
    for (const theme of ['light', 'dark'] as const) {
      const ratio = contrast(triplet('paper', theme), triplet('ink', theme));
      assert.ok(ratio >= AA, `paper on ink is ${ratio.toFixed(2)}:1 on ${theme}`);
    }
    for (const { text } of SOURCES) {
      for (const match of text.matchAll(/bg-ink(?![/-])[^"`]*/g)) {
        assert.ok(/text-paper\b/.test(match[0]), `an ink fill does not set text-paper: ${match[0].slice(0, 60)}`);
      }
    }
  });
});

describe('the sheet is a sheet', () => {
  const palette = SOURCES[0].text;

  test('all three modes share one container anchored to the bottom edge', () => {
    assert.match(palette, /fixed inset-x-0 bottom-0/);
    // One container, three bodies. Three geometries would be three different objects.
    assert.equal((palette.match(/fixed inset-x-0 bottom-0/g) ?? []).length, 1);
    for (const mode of ['search', 'ask', 'digest']) {
      assert.match(palette, new RegExp(`mode === '${mode}'`), `no body for the ${mode} mode`);
    }
  });

  test('the sheet insets its right edge by the rail, so it lands over the data', () => {
    assert.match(palette, /pr-\[calc\(var\(--mz-rail-w\)\+24px\)\]/);
    const rail = readFileSync(join(ROOT, 'client/src/components/NavRail.tsx'), 'utf8');
    assert.match(rail, /w-\[var\(--mz-rail-w\)\]/);
    // One declaration, outside both theme blocks: a metric, not a colour.
    assert.equal((CSS.match(/--mz-rail-w:/g) ?? []).length, 1);
  });

  test('the screen behind stays readable, which is the whole argument for a sheet', () => {
    assert.match(palette, /bg-ink\/10/);
    assert.ok(!palette.includes('backdrop-blur'), 'the sheet blurs the data it claims to sit beside');
  });

  /**
   * The sheet covers the screen, and says so.
   *
   * It used to be an overlay in appearance only: the route view stayed mounted and answering the
   * keyboard, and `digest` mode left focus on `document.body`, so `a` accepted an AI draft on the
   * ledger behind the sheet while the owner was reading the record of what the AI had already
   * done. What that declaration BUYS is driven in `tests/keyboard.test.ts`; what is checked here is
   * that this sheet makes it.
   */
  test('the sheet declares itself an overlay rather than leaving the screen live', () => {
    assert.match(palette, /useOverlay\('command-palette', open\)/);
    assert.ok(!palette.includes("addEventListener('keydown'"), 'the sheet listens for keys itself again');
    assert.match(palette, /'overlay\.close': \(\) => setOpen\(false\)/);
  });

  test('focus lands inside the sheet in the one mode that has no input', () => {
    // `search` and `ask` each own a composer; `digest` owns none, and its command button unmounts
    // with the list it was in.
    assert.match(palette, /role="dialog"/);
    assert.match(palette, /tabIndex=\{-1\}/);
    assert.match(palette, /if \(mode === 'digest'\) sheetRef\.current\?\.focus\(\)/);
  });

  test('the input is the last line in both modes that have one', () => {
    // Everything the app says grows upward above the composer. `flex-1 overflow-y-auto` is the body
    // and the bordered control line follows it, in that order, in each mode.
    const ask = SOURCES[1].text;
    for (const [name, text] of [['palette', palette], ['ask', ask]] as const) {
      const body = text.indexOf('min-h-0 flex-1 overflow-y-auto');
      const control = text.indexOf('flex-shrink-0 items-center gap-3 border-t border-line');
      assert.ok(body > -1 && control > -1, `${name} is missing a body or a control line`);
      assert.ok(control > body, `${name} puts its control line above its body`);
    }
  });
});
