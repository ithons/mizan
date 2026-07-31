import test from 'node:test';
import assert from 'node:assert/strict';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import {
  ANTHROPIC_UNSUPPORTED_KEYWORDS,
  GEMINI_IGNORED_KEYWORDS,
  OPENAI_UNSUPPORTED_KEYWORDS,
  PORTABLE_UNSUPPORTED_KEYWORDS,
  literal,
} from '../server/src/services/aiProviders/schema';

/**
 * The lists in schema.ts are owner-invisible but load-bearing: everything in the portable union
 * is a keyword no schema in this app may use, and `tests/aiRequestShape.test.ts` fails the build
 * if the worker's schema uses one. A keyword on that list for a reason no provider actually has
 * therefore removes an expressive JSON Schema feature from all three providers at once.
 *
 * `$ref`/`$defs` were on it for exactly that reason. This file pins them off, and pins the
 * removal to something checkable rather than to a comment: the installed Anthropic SDK's own
 * schema transform, which is the closest thing in this repo to Anthropic's subset expressed as
 * code. It preserves what the docs list as supported and discards what they do not.
 */

test('$ref and $defs are unsupported on no provider, so no list carries them', () => {
  for (const keyword of ['$ref', '$defs']) {
    assert.ok(
      !PORTABLE_UNSUPPORTED_KEYWORDS.includes(keyword),
      `'${keyword}' is back on the portable list; the docs of all three providers list it as supported`
    );
  }
});

test('the installed Anthropic SDK agrees with what ANTHROPIC_UNSUPPORTED_KEYWORDS claims', () => {
  // `transformJSONSchema` is what `@anthropic-ai/sdk`'s own schema helpers run before sending a
  // schema. Anything it carries through is in the subset; anything it drops out of the schema
  // body is not. mizan does NOT go through those helpers (aiProviders/anthropic.ts builds
  // `output_config.format` by hand), so this is evidence about the subset, not about our path.
  const transformed = transformJSONSchema({
    type: 'object',
    additionalProperties: false,
    required: ['ref_holder', 'constrained'],
    $defs: { leaf: { type: 'string' } },
    properties: {
      ref_holder: { $ref: '#/$defs/leaf' },
      constrained: { type: 'string', minLength: 3, pattern: '^a' },
    },
  }) as Record<string, Record<string, Record<string, unknown>>>;

  // Preserved, which is why they are not on the unsupported list.
  assert.deepEqual(transformed.$defs, { leaf: { type: 'string' } });
  assert.equal(transformed.properties.ref_holder.$ref, '#/$defs/leaf');

  // Not preserved as schema keywords, which is why they are.
  const constrained = transformed.properties.constrained;
  assert.equal(constrained.minLength, undefined);
  assert.equal(constrained.pattern, undefined);

  for (const keyword of ['minLength', 'pattern']) {
    assert.ok(
      ANTHROPIC_UNSUPPORTED_KEYWORDS.includes(keyword),
      `'${keyword}' does not survive the SDK's own transform but is missing from the list`
    );
  }
});

test('each provider list stays a subset of the portable union', () => {
  // The union is what every schema in this app is checked against. A keyword unusable on one
  // provider and absent from the union is a rule that silently stops being enforced there.
  for (const [provider, keywords] of [
    ['anthropic', ANTHROPIC_UNSUPPORTED_KEYWORDS],
    ['openai', OPENAI_UNSUPPORTED_KEYWORDS],
    ['gemini', GEMINI_IGNORED_KEYWORDS],
  ] as const) {
    for (const keyword of keywords) {
      assert.ok(
        PORTABLE_UNSUPPORTED_KEYWORDS.includes(keyword),
        `'${keyword}' is unusable on ${provider} but missing from the portable list`
      );
    }
  }
});

test('the Gemini list covers the constraint keywords its supported list omits', () => {
  // Quoted from the `responseJsonSchema` doc comment in the installed @google/genai 2.15.0:
  // the supported set is $id, $defs, $ref, $anchor, type, format, title, description, enum,
  // items, prefixItems, minItems, maxItems, minimum, maximum, anyOf, oneOf, properties,
  // additionalProperties, required. Anything else is ignored rather than rejected.
  for (const ignored of ['minLength', 'maxLength', 'pattern', 'multipleOf', 'const', 'allOf']) {
    assert.ok(GEMINI_IGNORED_KEYWORDS.includes(ignored), `Gemini ignores '${ignored}' unlisted`);
  }
  for (const supported of ['minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'enum']) {
    assert.ok(
      !GEMINI_IGNORED_KEYWORDS.includes(supported),
      `'${supported}' is on Gemini's own supported list and must not be marked ignored`
    );
  }
});

test('literal() stays the portable discriminator, and the SDK helper would demote it', () => {
  assert.deepEqual(literal('categorize_transaction'), { enum: ['categorize_transaction'] });

  // Measured, not assumed: the SDK's transform has no branch for `enum`, so it folds the
  // keyword into the schema's description as prose. Routing the worker schema through
  // `jsonSchemaOutputFormat` would turn every discriminator into a hint with no error, which
  // is why aiProviders/anthropic.ts builds the format object itself.
  const demoted = transformJSONSchema({
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: { kind: { type: 'string', ...literal('categorize_transaction') } },
  }) as { properties: { kind: { enum?: unknown; description?: string } } };

  assert.equal(demoted.properties.kind.enum, undefined);
  assert.match(String(demoted.properties.kind.description), /categorize_transaction/);
});
