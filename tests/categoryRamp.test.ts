import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The categorical identity ramp must exist exactly once.
 *
 * It briefly existed three times: eight literal hexes in CategoriesSection.tsx, sixteen
 * `--mz-cat-*` custom properties in index.css, and eight `cat-1..8` entries in tailwind.config.js.
 * The last two emitted zero utilities into the built CSS and nothing referenced them, so they were
 * two lists to keep in sync in exchange for nothing rendered. A category's colour is persisted as
 * a hex in `categories.color`, so the hex array is the copy that has to survive.
 */

const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const SECTION = read('client/src/views/settings/CategoriesSection.tsx');

describe('the ramp is not duplicated', () => {
  test('index.css declares no cat-* custom properties', () => {
    assert.equal(read('client/src/index.css').includes('--mz-cat-'), false);
  });

  test('tailwind.config.js exposes no cat-* colour', () => {
    const config = read('tailwind.config.js');
    assert.equal(/mz\('cat-\d'\)/.test(config), false);
    assert.equal(/^\s*cat:\s*\{/m.test(config), false);
  });

  test('CategoriesSection.tsx holds the only literal ramp', () => {
    assert.equal((SECTION.match(/CATEGORY_PRESET_COLORS\s*=/g) ?? []).length, 1);
  });
});

describe('the ramp is well formed', () => {
  const block = SECTION.match(/const CATEGORY_PRESET_COLORS = \[([^\]]+)\]/);
  const colors = [...(block?.[1] ?? '').matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1]);

  test('eight slots', () => {
    assert.equal(colors.length, 8);
  });

  test('every slot is a distinct six-digit hex', () => {
    assert.equal(new Set(colors.map((c) => c.toLowerCase())).size, 8);
  });

  test('the swatch picker is the single consumer, so a stored off-ramp colour stays reachable', () => {
    // Changing the array only changes what a NEW pick offers; existing rows keep their stored hex.
    // `ColorPicker` therefore has to render a value that is not in the array.
    assert.match(SECTION, /!isOnRamp\(value\) && swatch\(value, true\)/);
    assert.equal((SECTION.match(/<ColorPicker\b/g) ?? []).length, 2);
  });
});
