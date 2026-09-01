import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const CSS = readFileSync(join(ROOT, 'client/src/index.css'), 'utf8');

/**
 * The keyboard focus ring exists.
 *
 * `@tailwindcss/forms` emits `input:where([type="text"]):focus { outline: 2px solid transparent }`
 * and siblings into the same layer as the app's `:focus-visible` rule. `:where()` contributes no
 * specificity, so the plugin's selector is (0,1,1) against `:focus-visible`'s (0,1,0) and won on
 * every form control in the app. The comment above the rule said the outline was the field's whole
 * affordance, and it was transparent.
 *
 * Measured in Chrome against the running app before the fix, on a keyboard-focused input:
 *   matches(':focus-visible') -> true
 *   computed outline          -> "solid 2px rgba(0, 0, 0, 0)"
 * And after:
 *   computed outline          -> "solid 2px rgb(60, 137, 66)", outline-offset 2px
 */
test('the focus-visible outline cannot be overridden by the forms plugin', () => {
  const rule = CSS.slice(CSS.indexOf(':focus-visible {'), CSS.indexOf(':focus-visible {') + 200);
  assert.ok(rule.length > 20, 'there is no :focus-visible rule at all');
  assert.match(
    rule,
    /outline: 2px solid var\(--mz-sage\) !important;/,
    'the focus outline is overridable, and @tailwindcss/forms overrides it with transparent'
  );
  assert.match(rule, /outline-offset: 2px;/);
});

test('the premise still holds: the forms plugin is still loaded', () => {
  // If the plugin is ever dropped, the !important above stops being necessary and the comment
  // explaining it stops being true. This is where a reader finds that out.
  const tw = readFileSync(join(ROOT, 'tailwind.config.js'), 'utf8');
  assert.match(
    tw,
    /@tailwindcss\/forms/,
    'the forms plugin is gone; revisit why the focus outline is !important'
  );
});

test('no component turns the outline off again', () => {
  // `.mz-field` used to carry `focus:outline-none`, which is how this started. The class is still
  // in Tailwind's output for anything that asks for it, but nothing in the design-primitive layer
  // may ask.
  // Comments stripped: the note above `.mz-field` explains this defect by naming the utility it
  // is about, and reading that as a use of it is how a guard starts failing on its own docs.
  const components = CSS.slice(CSS.indexOf('@layer components'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    components,
    /focus:outline-none/,
    'a component layer class disables the focus outline'
  );
});
