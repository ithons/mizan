import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHORTCUTS,
  assertNoCollisions,
  chordOf,
  focusIsOnThePage,
  focusIsTyping,
  resolveKeystroke,
  shortcut,
  type BindingRef,
  type FocusedElement,
  type KeyboardScene,
  type Keystroke,
  type Shortcut,
  type ShortcutId,
} from '../client/src/lib/keyboard';
import { ALL_NAV_ITEMS } from '../client/src/components/NavRail';

/**
 * The keyboard, driven.
 *
 * Two defects produced this file, and they were the same defect from two directions: `g` `a`
 * navigated AND accepted the AI draft under the ledger's cursor, and the ⌘K sheet in `digest` mode
 * left focus on `document.body` so `a` accepted a draft behind the sheet. Both wrote to the
 * database. Both existed because three window listeners each decided on their own whether a
 * keystroke was theirs.
 *
 * `resolveKeystroke` takes the whole scene as data and returns exactly one outcome, so the claims
 * below are executed rather than asserted about source text: what runs, what is consumed, and what
 * runs nothing at all.
 */

const ROOT = join(import.meta.dirname, '..');

function focused(o: Partial<FocusedElement> = {}): FocusedElement {
  return { tagName: 'DIV', role: null, tabIndex: -1, isContentEditable: false, ...o };
}

/** Focus while the owner is reading a list: nothing focused, so the event target is the body. */
const READING = focused({ tagName: 'BODY' });
/** Focus in either composer the sheet has. */
const COMPOSER = focused({ tagName: 'INPUT', tabIndex: 0 });
/** What `digest` mode used to leave behind, and what clicking the transcript in `ask` mode gives. */
const NOTHING_FOCUSED = null;
/** Where the sheet now puts focus in the mode that has no input of its own. */
const SHEET_BODY = focused({ tagName: 'DIV', tabIndex: -1 });

const NAV_RAIL: BindingRef[] = ALL_NAV_ITEMS.map((item) => ({ id: item.shortcut, owner: 'nav-rail' }));
const LEDGER_KEYS: ShortcutId[] = SHORTCUTS.filter((s) => s.id.startsWith('ledger.')).map((s) => s.id);
const LEDGER: BindingRef[] = LEDGER_KEYS.map((id) => ({ id, owner: 'ledger' }));
const PALETTE: BindingRef[] = [
  { id: 'palette.toggle', owner: 'command-palette' },
  { id: 'overlay.close', owner: 'command-palette' },
];

interface Sequence {
  /** Shortcut ids that fired, in order. */
  ran: string[];
  /** The owner of each, in the same order. */
  owners: string[];
  /** Whether each keystroke was taken away from the page. */
  consumed: boolean[];
}

/** Presses keys in order against one scene, carrying the armed prefix the way the listener does. */
function press(scene: Omit<KeyboardScene, 'armedPrefix'>, strokes: Array<string | Keystroke>): Sequence {
  let armed: string | null = null;
  const out: Sequence = { ran: [], owners: [], consumed: [] };
  for (const raw of strokes) {
    const stroke: Keystroke = typeof raw === 'string' ? { key: raw } : raw;
    const res = resolveKeystroke({ ...scene, armedPrefix: armed }, stroke);
    armed = res.armed;
    out.consumed.push(res.kind === 'run' || res.kind === 'spend');
    if (res.kind === 'run') {
      out.ran.push(res.binding.id);
      out.owners.push(res.binding.owner);
    }
  }
  return out;
}

// ─── The table ────────────────────────────────────────────────────────────────

describe('the one table', () => {
  test('the shipped table has no collision in it', () => {
    assert.doesNotThrow(() => assertNoCollisions(SHORTCUTS));
  });

  test('every shortcut says what it does, in words an owner could be shown', () => {
    for (const s of SHORTCUTS) {
      assert.ok(s.describes.length > 0, `${s.id} describes nothing`);
      assert.equal(s.chord, s.chord.toLowerCase(), `${s.id} has a chord that is not canonical`);
    }
  });

  test('one modifier chord in the whole app, and it is ⌘K', () => {
    // ⌘1 to ⌘9 switch browser tabs, ⌘0 resets zoom, ⌘R reloads, ⌘P prints, ⌘S saves the page.
    const modifiers = SHORTCUTS.filter((s) => s.chord.startsWith('mod+'));
    assert.deepEqual(
      modifiers.map((s) => s.chord),
      ['mod+k']
    );
    assert.equal(modifiers[0].id, 'palette.toggle');
  });

  test('every bare letter that writes is the strictest kind of binding there is', () => {
    // `a` accepts an AI categorization and `x` drops one. Both write, and neither has a modifier
    // in front of it, so both are confined to the screen layer and to focus resting on the page.
    for (const id of LEDGER_KEYS) {
      const s = shortcut(id);
      assert.equal(s.layer, 'screen', `${id} is not confined to the screen it belongs to`);
      assert.equal(s.focus, 'page', `${id} fires while the owner is operating a control`);
    }
  });

  test('the six destinations are six distinct chords under one prefix', () => {
    const chords = ALL_NAV_ITEMS.map((item) => chordOf(item.shortcut));
    assert.equal(new Set(chords).size, chords.length, 'two destinations share a chord');
    for (const item of ALL_NAV_ITEMS) {
      const chord = chordOf(item.shortcut);
      assert.equal(chord.slice(0, 2), 'g ', `${item.label} is not under the g prefix`);
      assert.equal(chord.slice(2), item.label[0].toLowerCase(), `${item.label} does not start with ${chord}`);
    }
  });
});

// ─── A claimed chord fails loudly ─────────────────────────────────────────────

describe('a screen that claims something already claimed', () => {
  const ledgerAccept = shortcut('ledger.acceptSuggestion');

  function table(extra: Shortcut): readonly Shortcut[] {
    return [...SHORTCUTS, extra];
  }

  test('a second screen claiming `a` throws, naming both claimants', () => {
    assert.throws(
      () =>
        assertNoCollisions(
          table({ id: 'plan.addGoal', chord: 'a', layer: 'screen', focus: 'page', describes: 'Add a goal' })
        ),
      /plan\.addGoal.*already claimed by "ledger\.acceptSuggestion"/s
    );
    assert.equal(ledgerAccept.chord, 'a');
  });

  test('a screen reaching for the app chrome throws too', () => {
    assert.throws(
      () =>
        assertNoCollisions(
          table({ id: 'plan.komma', chord: 'mod+k', layer: 'screen', focus: 'anywhere', describes: 'x' })
        ),
      /already claimed by "palette\.toggle"/
    );
  });

  test('claiming the prefix itself throws, because the prefix spends the next keystroke', () => {
    assert.throws(
      () => assertNoCollisions(table({ id: 'plan.go', chord: 'g', layer: 'screen', focus: 'page', describes: 'x' })),
      /already the prefix of a chord/
    );
  });

  test('a duplicate id and a malformed chord both throw', () => {
    assert.throws(
      () => assertNoCollisions(table({ ...ledgerAccept, chord: 'q' })),
      /"ledger\.acceptSuggestion" is declared twice/
    );
    assert.throws(
      () => assertNoCollisions(table({ id: 'plan.q', chord: 'Ctrl-Q', layer: 'app', focus: 'anywhere', describes: 'x' })),
      /not a canonical chord/
    );
  });

  test('an overlay may shadow a screen, because covering it is what an overlay is', () => {
    assert.doesNotThrow(() =>
      assertNoCollisions(
        table({ id: 'sheet.accept', chord: 'a', layer: 'overlay', focus: 'page', describes: 'Accept' })
      )
    );
  });
});

// ─── The `g` chord and the ledger's accept key ────────────────────────────────

describe('g then a, on the ledger, with a draft under the cursor', () => {
  const onLedger = { bindings: [...NAV_RAIL, ...LEDGER, ...PALETTE], overlays: [], focus: READING };

  test('navigates, and writes nothing', () => {
    const seq = press(onLedger, ['g', 'a']);
    assert.deepEqual(seq.ran, ['nav.accounts']);
    assert.ok(!seq.ran.includes('ledger.acceptSuggestion'), 'the accept key ran on the same dispatch');
    // The second keystroke never reaches the page: that is the whole fix, and `preventDefault`
    // alone was not it, because it does not stop another listener on the same target.
    assert.deepEqual(seq.consumed, [false, true]);
  });

  test('g then x drops no suggestion either, even though `g x` names nothing', () => {
    // An armed prefix owns the next keystroke whether or not the pair matches. A chord that misses
    // is a chord that missed, not a free letter handed to the screen underneath.
    const seq = press(onLedger, ['g', 'x']);
    assert.deepEqual(seq.ran, []);
    assert.deepEqual(seq.consumed, [false, true]);
  });

  test('every nav chord whose letter is also a ledger key stays unambiguous', () => {
    for (const item of ALL_NAV_ITEMS) {
      const letter = chordOf(item.shortcut).slice(2);
      const seq = press(onLedger, ['g', letter]);
      assert.deepEqual(seq.ran, [item.shortcut], `g ${letter} did not resolve to exactly one thing`);
    }
  });

  test('the letters still work on their own once the prefix is not in force', () => {
    assert.deepEqual(press(onLedger, ['a']).ran, ['ledger.acceptSuggestion']);
    assert.deepEqual(press(onLedger, ['x']).ran, ['ledger.dismissSuggestion']);
    assert.deepEqual(press(onLedger, ['j', 'k']).ran, ['ledger.nextSuggestion', 'ledger.prevSuggestion']);
  });

  test('a modifier held down while the prefix waits goes to the app, not to the chord', () => {
    const seq = press(onLedger, ['g', { key: 'k', meta: true }]);
    assert.deepEqual(seq.ran, ['palette.toggle']);
  });

  test('the prefix is inert while the owner is typing', () => {
    const typing = { ...onLedger, focus: COMPOSER };
    const seq = press(typing, ['g', 'a']);
    assert.deepEqual(seq.ran, []);
    assert.deepEqual(seq.consumed, [false, false], 'the search field lost a letter to the navigation');
  });
});

// ─── The sheet neutralises the screen underneath ──────────────────────────────

describe('with the ⌘K sheet open', () => {
  const bindings = [...NAV_RAIL, ...LEDGER, ...PALETTE];
  const overlays = ['command-palette'];

  /**
   * The three modes, as the resolver sees them: what has focus.
   *
   * `search` and `ask` own an input. `digest` has none, its command button unmounts with the list,
   * and focus fell back to `document.body`; `ask` reaches the same state by clicking the transcript
   * before typing. Both are the reported defect, and `SHEET_BODY` is where focus goes now.
   */
  const MODES: Array<{ mode: string; focus: FocusedElement | null }> = [
    { mode: 'search', focus: COMPOSER },
    { mode: 'ask (composer)', focus: COMPOSER },
    { mode: 'ask (clicked the transcript)', focus: NOTHING_FOCUSED },
    { mode: 'digest (as it used to leave focus)', focus: READING },
    { mode: 'digest (where focus goes now)', focus: SHEET_BODY },
  ];

  for (const { mode, focus } of MODES) {
    test(`no ledger key does anything in ${mode}`, () => {
      for (const key of ['j', 'k', 'a', 'x']) {
        const seq = press({ bindings, overlays, focus }, [key]);
        assert.deepEqual(seq.ran, [], `${key} reached the ledger behind the sheet in ${mode}`);
      }
      // The whole point: `a` behind the digest applied an AI categorization while the owner was
      // reading the record of what the AI had already applied. Navigation is unaffected by the
      // sheet (it is app chrome), except in a composer, where letters are letters.
      assert.deepEqual(
        press({ bindings, overlays, focus }, ['g', 'a']).ran,
        focusIsTyping(focus) ? [] : ['nav.accounts']
      );
    });
  }

  test('escape reaches the sheet, and ⌘K still closes it from inside', () => {
    const scene = { bindings, overlays, focus: SHEET_BODY };
    const esc = press(scene, ['Escape']);
    assert.deepEqual(esc.ran, ['overlay.close']);
    assert.deepEqual(esc.owners, ['command-palette']);
    assert.deepEqual(press(scene, [{ key: 'k', meta: true }]).ran, ['palette.toggle']);
  });

  test('a dialog opened over the sheet takes the escape, and only that dialog', () => {
    const scene = {
      bindings: [...bindings, { id: 'overlay.close' as ShortcutId, owner: 'modal-7' }],
      overlays: ['command-palette', 'modal-7'],
      focus: READING,
    };
    const seq = press(scene, ['Escape']);
    assert.deepEqual(seq.ran, ['overlay.close']);
    assert.deepEqual(seq.owners, ['modal-7'], 'both the dialog and the sheet closed on one press');
  });

  test('a modal over the ledger makes the ledger keys inert without the ledger knowing', () => {
    // The condition this replaces was `showAddEntry || showAddScheduled || editing`, a list of the
    // overlays the ledger happened to know about, which is why the sheet reached past it.
    const scene = {
      bindings: [...bindings, { id: 'overlay.close' as ShortcutId, owner: 'modal-1' }],
      overlays: ['modal-1'],
      focus: READING,
    };
    for (const key of ['j', 'k', 'a', 'x']) {
      assert.deepEqual(press(scene, [key]).ran, [], `${key} reached the ledger behind a dialog`);
    }
  });
});

describe('with the sheet closed', () => {
  const scene = { bindings: [...NAV_RAIL, ...LEDGER, ...PALETTE], overlays: [], focus: READING };

  test('the ledger keys work exactly as they did', () => {
    assert.deepEqual(press(scene, ['j']).ran, ['ledger.nextSuggestion']);
    assert.deepEqual(press(scene, ['k']).ran, ['ledger.prevSuggestion']);
    assert.deepEqual(press(scene, ['a']).ran, ['ledger.acceptSuggestion']);
    assert.deepEqual(press(scene, ['x']).ran, ['ledger.dismissSuggestion']);
    assert.deepEqual(press(scene, ['a']).consumed, [true]);
  });

  test('a screen that has not registered them gets nothing', () => {
    // The ledger passes `enabled: false` when no suggestion is on screen, and every other route
    // registers no bare letters at all.
    const elsewhere = { ...scene, bindings: [...NAV_RAIL, ...PALETTE] };
    for (const key of ['j', 'k', 'a', 'x']) {
      assert.deepEqual(press(elsewhere, [key]).ran, [], `${key} ran on a screen that never claimed it`);
    }
    // And the prefix does not swallow the letter after it when there is nothing to reach.
    assert.deepEqual(press({ ...scene, bindings: [] }, ['g', 'a']).consumed, [false, false]);
  });

  test('a key nothing claims is left alone', () => {
    const seq = press(scene, ['q', 'Enter', 'ArrowDown', 'Escape']);
    assert.deepEqual(seq.ran, []);
    assert.deepEqual(seq.consumed, [false, false, false, false]);
  });

  test('a modifier key pressed on its own does not disarm a waiting prefix', () => {
    // Reaching for a capital letter must not cost the chord its second key.
    assert.deepEqual(press(scene, ['g', 'Shift', 'a']).ran, ['nav.accounts']);
  });
});

// ─── Where focus is ───────────────────────────────────────────────────────────

describe('whether focus is on the page', () => {
  test('nothing focused, and a plain element, are both the page', () => {
    assert.equal(focusIsOnThePage(null), true);
    assert.equal(focusIsOnThePage(focused({ tagName: 'BODY' })), true);
    assert.equal(focusIsOnThePage(focused({ tagName: 'DIV' })), true);
  });

  test('a focused Select does NOT hand `a` to the screen', () => {
    // `components/balance/Select` renders <button role="combobox">, whose tagName is BUTTON, so the
    // old ['INPUT','TEXTAREA','SELECT'] allowlist let the key through: focusing the ledger's account
    // filter and pressing `a` confirmed the AI draft under the cursor and wrote it.
    assert.equal(focusIsOnThePage(focused({ tagName: 'BUTTON', role: 'combobox', tabIndex: 0 })), false);
  });

  test('every other control keeps its own keystrokes too', () => {
    for (const tagName of ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A', 'SUMMARY']) {
      assert.equal(focusIsOnThePage(focused({ tagName, tabIndex: 0 })), false, tagName);
    }
    assert.equal(focusIsOnThePage(focused({ tagName: 'DIV', role: 'textbox' })), false);
    assert.equal(focusIsOnThePage(focused({ tagName: 'DIV', role: 'option' })), false);
    assert.equal(focusIsOnThePage(focused({ tagName: 'DIV', tabIndex: 0 })), false);
    // Case and stray whitespace in an attribute must not open the hole again.
    assert.equal(focusIsOnThePage(focused({ tagName: 'button' })), false);
    assert.equal(focusIsOnThePage(focused({ tagName: 'DIV', role: ' ComboBox ' })), false);
    // contenteditable is inherited, so a descendant of an editor reports it too.
    assert.equal(focusIsOnThePage(focused({ tagName: 'SPAN', isContentEditable: true })), false);
  });

  test('a container the page merely scrolls does not count as a control', () => {
    // tabindex="-1" is "focusable by script, not by the owner". Treating it as a control would make
    // the shortcuts inert after any programmatic focus, which is the opposite failure.
    assert.equal(focusIsOnThePage(focused({ tagName: 'DIV', tabIndex: -1 })), true);
  });

  test('typing is the narrower question the navigation prefix asks', () => {
    assert.equal(focusIsTyping(focused({ tagName: 'INPUT' })), true);
    assert.equal(focusIsTyping(focused({ tagName: 'SPAN', isContentEditable: true })), true);
    // A button is not a typing target, so `g l` still works from one. It is not the page either,
    // which is why the ledger's writing keys do not fire there.
    assert.equal(focusIsTyping(focused({ tagName: 'BUTTON', tabIndex: 0 })), false);
    assert.equal(focusIsOnThePage(focused({ tagName: 'BUTTON', tabIndex: 0 })), false);
  });
});

// ─── Nothing else listens ─────────────────────────────────────────────────────

test('exactly one place in the client listens for a keystroke globally', () => {
  // The finding behind all of this: three window-level listeners, each deciding independently
  // whether a keystroke was its business, produced the same write-to-the-database defect twice. A
  // fourth would produce a third. Element-scoped React `onKeyDown` handlers are untouched by this:
  // they run on the control that has focus, which is exactly where they belong.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(join(ROOT, 'client/src'));

  const listeners = files.filter((path) =>
    /(?:window|document)\.addEventListener\(\s*['"]key(?:down|up|press)['"]/.test(readFileSync(path, 'utf8'))
  );
  assert.deepEqual(
    listeners.map((p) => p.slice(ROOT.length + 1)),
    ['client/src/lib/keyboard.ts']
  );
});
