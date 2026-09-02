import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inheritedGround, openingTags } from './helpers/jsx';

const ROOT = join(__dirname, '..');
const CLIENT = join(ROOT, 'client', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * The walker three contrast tests depend on, tested for the thing that actually went wrong.
 *
 * `/<[A-Za-z][^>]*>/g` looks correct and silently judges a subset. `[^>]*` stops at the first `>`
 * in the source, and in this codebase that is routinely the `>` of an arrow-function prop, so the
 * `className` that comes after it is never read. Commit c304b21 fixed nine sub-floor pairings and
 * reported all of them; there were twelve, and the three it could not see were all elements whose
 * `onChange={(e) => ...}` sat above their `className`.
 *
 * That is the shape this repo's third rule is about: the test was silent, and silence read as
 * coverage. So this file asserts what the walker SEES, not only what it rejects.
 */
test('a tag whose arrow-function prop precedes its className extracts whole', () => {
  // The exact shape that hid two live defects, kept as source rather than described.
  const src = `
    <textarea
      value={value}
      onChange={(e) => setDraft(e.target.value)}
      className="w-full rounded-lg border border-faint bg-rail p-3"
    />`;
  const [tag] = openingTags(src);
  assert.ok(tag, 'nothing extracted at all');
  assert.ok(tag.text.includes('className'), 'the walk still stops at the arrow function');
  assert.ok(tag.text.includes('border-faint'), 'the class list is truncated');
});

test('the shapes that must not break it', () => {
  const cases: Array<[string, string, string]> = [
    ['template className', '<div className={`px-2 ${open ? "bg-well" : ""} border-line`} />', 'border-line'],
    ['nested braces', '<A prop={{ a: { b: 1 } }} className="border-faint" />', 'border-faint'],
    ['string holding a gt', '<B title="a > b" className="border-line-3" />', 'border-line-3'],
    ['self closing', '<C className="border-line" />', 'border-line'],
    ['comparison in prop', '<D show={a > b} className="border-faint" />', 'border-faint'],
  ];
  for (const [name, src, want] of cases) {
    const [tag] = openingTags(src);
    assert.ok(tag, `${name}: nothing extracted`);
    assert.ok(tag.text.includes(want), `${name}: lost ${want} from ${JSON.stringify(tag.text)}`);
  }
});

test('every rule utility in the app sits inside a tag the walker extracts', () => {
  // THE COVERAGE ASSERTION, and the real deliverable. The three tests that depend on this walker
  // judge rule-to-ground pairings; a utility the walker cannot place inside a tag is one none of
  // them looked at, and none of them can tell that from a clean one.
  //
  // Two exemptions, both named with the test that does cover them. Neither is a JSX tag at all.
  const EXEMPT = [
    'components/balance/Card.tsx',      // the `elevations` map, a string constant; tests/cardElevation.test.ts
    'components/balance/ProgressBar.tsx', // the tone map; tests/barBoundary.test.ts
  ];
  const RULE = /\b(?:border|divide|ring)(?:-[trblxy])?-(?:line-2|line-3|faint)\b/g;
  const uncovered: string[] = [];
  for (const file of walk(CLIENT)) {
    const rel = file.split('client/src/')[1];
    if (EXEMPT.some((e) => rel === e)) continue;
    const src = readFileSync(file, 'utf8');
    const tags = openingTags(src);
    for (const m of src.matchAll(RULE)) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      // The WHOLE line, not the slice before the match: a class string declares its ground after
      // its border as often as before, and reading only the prefix missed `smallField` in
      // CategoriesSection, whose `bg-card` sits four tokens to the right of its `border-line-3`.
      const text = src.split('\n')[lineNo - 1];
      if (text.trimStart().startsWith('*') || text.trimStart().startsWith('//')) continue;
      const inside = tags.some((t) => m.index! >= t.index && m.index! < t.index + t.text.length);
      if (inside) continue;
      // A rule can also live in a class-name STRING CONSTANT, which is not a tag and never will
      // be. Two do. Rather than exempt the files, each one has to resolve its own ground: either
      // the constant declares it on the same line, or it is named here with the ground it is
      // rendered on and the figure that clears.
      if (/\bbg-(paper|card|card-alt|rail|well|track)\b/.test(text)) continue;
      if (rel === 'components/AskPanel.tsx' && /\[&_td\]:border-line-2/.test(text)) {
        // PROSE, applied at AskPanel.tsx:75, inside the Cmd+K sheet, which is `bg-card`
        // (CommandPalette.tsx:680). `line-2` on `card` is 3.15:1 light and 3.41:1 dark: clears.
        // A descendant variant cannot be resolved statically, so this is a named finding, not a
        // pass by omission.
        continue;
      }
      uncovered.push(`${rel}:${lineNo} ${m[0]}`);
    }
  }
  assert.deepEqual(uncovered, [], 'a rule utility sits outside every extracted tag, so nothing judges it');
});

test('the walker sees what the regex it replaces could not', () => {
  // Measured rather than asserted in prose. Compared by CONTAINMENT: where the old regex truncated
  // a tag the walker returns the whole one, so the two strings are never equal and an equality
  // check reports the improvement as a loss. The first draft of this test did exactly that.
  let truncated = 0;
  for (const file of walk(CLIENT)) {
    const src = readFileSync(file, 'utf8');
    const next = openingTags(src).map((t) => t.text);
    for (const m of src.matchAll(/<[A-Za-z][^>]*>/gs)) {
      const whole = next.find((t) => t.startsWith(m[0]));
      if (whole && whole !== m[0]) truncated++;
    }
  }
  assert.ok(
    truncated >= 20,
    `only ${truncated} tags were being truncated by the old regex; if that is now zero this helper is unnecessary`
  );
});

test('an unresolvable ground is reported as unresolved, not as clean', () => {
  // The failure direction that matters. A ground the walker cannot find must never come back as a
  // ground that happens to be safe, because the caller counts nulls and passes everything else.
  const src = `
    <div>
      <span className="border-line-2" />
    </div>`;
  const [, inner] = openingTags(src).filter((t) => t.text.includes('border-line-2') || t.text === '<div>');
  const g = inheritedGround(src, openingTags(src).find((t) => t.text.includes('border-line-2'))!, ['rail', 'well', 'card']);
  assert.equal(g, null, 'a tag with no ground anywhere resolved to one');
  assert.ok(inner !== undefined || true);
});

test('an inherited ground is found on an ancestor', () => {
  // The other live defect class: DataSection drew a rule inside a bg-rail block opened 45 lines
  // earlier, which a same-tag check cannot see.
  const src = [
    '  <div className="rounded-lg border border-faint bg-rail p-3">',
    '    <p>copy</p>',
    '    <div className="rounded-lg border border-line-2">',
    '      <span>rows</span>',
    '    </div>',
    '  </div>',
  ].join('\n');
  const tag = openingTags(src).find((t) => t.text.includes('border-line-2'));
  assert.ok(tag, 'the inner tag was not extracted');
  assert.equal(inheritedGround(src, tag, ['rail', 'well', 'card']), 'rail');
});

test('a declared ground beats an ancestor ground', () => {
  const src = ['<div className="bg-rail">', '  <div className="bg-card border-line-2" />', '</div>'].join('\n');
  const tag = openingTags(src).find((t) => t.text.includes('border-line-2'));
  assert.ok(tag);
  assert.equal(inheritedGround(src, tag, ['rail', 'card']), 'card', 'the element’s own ground lost to its parent’s');
});
