import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nextTabStop } from '../client/src/lib/keyboard';
import { openingTags } from './helpers/jsx';

const ROOT = join(__dirname, '..');
const CLIENT = join(ROOT, 'client', 'src');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * What a dialog owes a reader who is not using a mouse.
 *
 * `rebuild-part-3.md` Decision 5 calls `role="dialog"` and focus restore "the two items that
 * genuinely do not wait" and pulls them into Phase 12. Measured on 2026-09-03, before this file:
 * `CommandPalette` had the role and `aria-modal`, `components/Modal` had neither, and
 * `grep -rn activeElement client/src` returned **nothing at all**, so no dialog in the app ever
 * gave focus back. Seven components render through `Modal`, so seven dialogs announced as an
 * unnamed group, never took focus, and dropped it on `<body>` when they closed.
 *
 * `aria-modal="true"` is the reason the trap is here rather than deferred. The attribute tells
 * assistive tech the rest of the page is inert and no browser enforces it, so a dialog that
 * declares it and lets Tab walk out behind its own scrim states something its code does not check.
 */
test('every dialog declares a role, a modal flag, and a name', () => {
  const dialogs = [
    ['client/src/components/Modal.tsx', 'aria-labelledby'],
    ['client/src/components/CommandPalette.tsx', 'aria-label'],
  ] as const;
  for (const [file, naming] of dialogs) {
    const src = read(file);
    const panel = openingTags(src).find((t) => t.text.includes('role="dialog"'));
    assert.ok(panel, `${file} renders no element with role="dialog"`);
    assert.match(panel.text, /aria-modal="true"/, `${file}'s dialog is not modal`);
    assert.ok(panel.text.includes(naming), `${file}'s dialog has no accessible name`);
    // Script may focus the panel; Tab may not stop on it. Without this the trap offers the panel
    // as a stop and Tab appears to do nothing on the first press.
    assert.match(panel.text, /tabIndex=\{-1\}/, `${file}'s dialog panel is not script-focusable`);
  }
});

test('the dialog is named by the heading it actually renders', () => {
  // A dangling `aria-labelledby` announces nothing and is worse than no name, because it looks
  // done. The id has to be on the element carrying the title.
  const src = read('client/src/components/Modal.tsx');
  assert.match(src, /const titleId = `\$\{owner\}-title`/, 'the title id is gone');
  assert.match(src, /aria-labelledby=\{titleId\}/);
  assert.match(src, /<h2 id=\{titleId\}[^>]*>\{title\}<\/h2>/, 'the id is not on the heading that holds the title');
  // `useId` rather than a constant. Seven callers instantiate this component and `Accounts.tsx`
  // mounts four in one tree; only the open one renders, so a constant would not collide today and
  // would the first time two are open together.
  assert.match(src, /const owner = useId\(\)/, 'two open dialogs would now share one title id');
});

test('focus enters the dialog and is given back when it closes', () => {
  const modal = read('client/src/components/Modal.tsx');
  assert.match(modal, /if \(open\) panelRef\.current\?\.focus\(\)/, 'focus never enters the dialog');

  const kb = read('client/src/lib/keyboard.ts');
  assert.match(kb, /const restoreTo = document\.activeElement/, 'nothing records what had focus');
  assert.match(kb, /restoreTo\?\.isConnected/, 'focus is restored to an element that may be gone');
  assert.match(kb, /restoreTo\.focus\(\)/, 'focus is recorded and never given back');
});

test('restore fires only when focus was actually lost', () => {
  // THE SILENCE HALF. A dialog that hands focus somewhere deliberately (a row it filed, a field it
  // opened) must not have it yanked back to the button that opened the dialog. Restoring
  // unconditionally would be the more obvious code and the wrong behaviour.
  const kb = read('client/src/lib/keyboard.ts');
  const cleanup = kb.slice(kb.indexOf('const restoreTo'), kb.indexOf('const restoreTo') + 1400);
  assert.match(cleanup, /now === document\.body/, 'restore does not check whether focus was lost');
  assert.match(cleanup, /if \(lost && restoreTo\?\.isConnected\)/, 'restore is unconditional');
});

test('Tab cycles inside the dialog, in both directions, from anywhere', () => {
  // The arithmetic, which is the part with an off-by-one in it. The wrapping needs a browser; this
  // does not, and this repo has no DOM in its test environment.
  assert.equal(nextTabStop(3, 0, false), 1);
  assert.equal(nextTabStop(3, 1, false), 2);
  assert.equal(nextTabStop(3, 2, false), 0, 'Tab off the last stop escapes the dialog');
  assert.equal(nextTabStop(3, 2, true), 1);
  assert.equal(nextTabStop(3, 0, true), 2, 'Shift+Tab off the first stop escapes the dialog');
  // Focus not on any stop: the panel itself, or an element outside that took it. Enters at the near
  // end for the direction travelled rather than jumping into the middle.
  assert.equal(nextTabStop(3, -1, false), 0);
  assert.equal(nextTabStop(3, -1, true), 2);
  // One stop is still a cycle, and must not read as "nothing to do".
  assert.equal(nextTabStop(1, 0, false), 0);
  assert.equal(nextTabStop(1, 0, true), 0);
});

test('a dialog with nothing tabbable does not swallow Tab', () => {
  // The other silence case. With no cycle to keep focus in, taking the keystroke leaves the reader
  // pressing Tab against a dialog that never moves. The caller returns before calling this, and the
  // function refuses rather than returning a plausible index.
  assert.throws(() => nextTabStop(0, -1, false), /must not contain Tab/);
  const kb = read('client/src/lib/keyboard.ts');
  assert.match(kb, /if \(items\.length === 0\) return false;/, 'an empty dialog now eats Tab');
});

test('Tab is contained by the topmost overlay only, and nothing else claims it', () => {
  const kb = read('client/src/lib/keyboard.ts');
  assert.match(kb, /const top = overlays\[overlays\.length - 1\]/, 'the trap does not respect the stack');
  // Tab got a branch inside the one listener, not a listener of its own. That rule is already
  // owned by `keyboard.test.ts:391` ("exactly one place in the client listens for a keystroke
  // globally") and is deliberately not restated here; what this asserts is that the branch sits
  // ahead of the binding table, since Tab owns no row and a dialog's claim on it outranks one.
  const guard = kb.indexOf('if (containTab(e)) return;');
  const table = kb.indexOf('const resolution = resolveKeystroke(');
  assert.ok(guard > -1, 'Tab is no longer contained at all');
  assert.ok(guard < table, 'the binding table gets Tab before the open dialog does');
});

test('every dialog in the app goes through the component that has this', () => {
  // The reason one fix covers seven screens, asserted so a new hand-rolled overlay is visible.
  const rolled: string[] = [];
  for (const file of walk(CLIENT)) {
    const rel = file.replace(ROOT + '/client/src/', '');
    if (rel === 'components/Modal.tsx' || rel === 'components/CommandPalette.tsx') continue;
    const src = readFileSync(file, 'utf8');
    if (/role="dialog"/.test(src)) rolled.push(rel);
  }
  assert.deepEqual(rolled, [], 'a dialog was hand-rolled outside Modal and CommandPalette');

  const users = walk(CLIENT).filter((f) => /from '.*\/Modal'|from '\.\/Modal'/.test(readFileSync(f, 'utf8')));
  assert.ok(users.length >= 6, `only ${users.length} files use Modal; this fix covers fewer screens than stated`);
});
