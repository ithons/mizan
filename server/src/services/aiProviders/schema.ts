import type { AiProviderId } from './types';

/**
 * What each provider's structured-output mode does with a JSON Schema.
 *
 * Every list below was read on 2026-07-31 from a source that ships with the thing it describes,
 * because the previous version of this file was written from recall and got two keywords wrong
 * in the direction that costs the most: it forbade something all three providers support.
 *
 *   Anthropic  platform.claude.com/docs/en/build-with-claude/structured-outputs. Its SUPPORTED
 *     list is `enum`, `const`, `anyOf`, `allOf`, `$ref`/`$defs`, the basic types, the named
 *     string formats, and `additionalProperties: false`. Its NOT-supported list is recursive
 *     schemas, numerical constraints, string constraints, complex array constraints, and
 *     `additionalProperties` set to anything but false. Corroborated by the installed SDK:
 *     `@anthropic-ai/sdk` 0.100.1's `lib/transform-json-schema.ts` carries `$ref`, `$defs`,
 *     `anyOf` and `allOf` through untouched and forces `additionalProperties` to false.
 *   OpenAI     its strict subset permits `pattern`, `format`, `multipleOf`, the min/max family
 *     and `minItems`/`maxItems`, and forbids `allOf`, `not`, `dependentRequired`,
 *     `dependentSchemas`, `if`/`then`/`else`. Its root object must not be `anyOf`, though
 *     nested `anyOf` is fine. `$ref` is supported: the installed `openai` 7.3.0 emits refs
 *     deliberately under strict mode (`helpers/zod.ts` sets `$refStrategy: 'extract-to-root'`
 *     alongside `openaiStrictMode: true`, then rewrites the refs rather than inlining them).
 *   Gemini     publishes a supported LIST rather than a forbidden one, quoted verbatim in the
 *     installed `@google/genai` 2.15.0 on the `responseJsonSchema` field: `$id`, `$defs`,
 *     `$ref`, `$anchor`, `type`, `format`, `title`, `description`, `enum` (strings and
 *     numbers), `items`, `prefixItems`, `minItems`, `maxItems`, `minimum`, `maximum`, `anyOf`,
 *     `oneOf` (read as `anyOf`), `properties`, `additionalProperties`, `required`. Anything
 *     else is ignored: the failure mode is silence, not a 400.
 *
 * The intersection is what mizan writes, and the one keyword that bit is `const`: Anthropic
 * supports it, OpenAI does not document it, and Gemini's list omits it. Since `const` is what
 * makes `kind` a discriminator in WORKER_DRAFTS_SCHEMA, dropping it silently would delete the
 * cross-field rule the payload reaches a write path through. A single-member `enum` says the
 * same thing and is on all three lists, so that is what the worker emits.
 *
 * WHAT HAPPENS TO A KEYWORD A PROVIDER DOES NOT TAKE IS NOT MEASURED HERE, and this file no
 * longer claims it is. The one thing that IS measured is that mizan gets no client-side
 * cleanup: `@anthropic-ai/sdk`'s `transformJSONSchema` runs only inside its schema helpers
 * (`jsonSchemaOutputFormat`, `zodOutputFormat`, the tool builders), and `aiProviders/anthropic.ts`
 * hands `output_config.format` a schema it built itself, so the schema reaches the API byte for
 * byte. Whatever the API does with an out-of-subset keyword, it does to ours.
 */

/**
 * Keywords outside Anthropic's documented structured-output subset.
 *
 * `$ref` and `$defs` used to be on this list and are not on it now: the docs list both as
 * supported, and the SDK's own transform preserves both. They were also propagating into the
 * portable union, so a schema using `$defs` was rejected on all three providers for a reason
 * none of them has.
 */
export const ANTHROPIC_UNSUPPORTED_KEYWORDS: readonly string[] = [
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties', 'patternProperties',
];

/** Keywords OpenAI's strict subset rejects. */
export const OPENAI_UNSUPPORTED_KEYWORDS: readonly string[] = [
  'allOf', 'not', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else',
];

/**
 * Keywords absent from Gemini's supported list, which it therefore does not act on. It ignores
 * rather than rejects them, so anything here is a rule that quietly stops being enforced.
 *
 * Longer than it was, because the previous version listed only the structural keywords and
 * left the string and number constraints off. They cost nothing to add (the Anthropic list
 * already carries most of them into the union) and `unsupportedKeywordsFor('gemini')` is now
 * true rather than partial.
 */
export const GEMINI_IGNORED_KEYWORDS: readonly string[] = [
  'const', 'allOf', 'not', 'patternProperties', 'uniqueItems', 'if', 'then', 'else',
  'minLength', 'maxLength', 'pattern', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas',
];

/**
 * Keywords no schema in this app may use, because at least one provider would reject or
 * silently drop them. This is the union that keeps ONE schema correct on all three.
 */
export const PORTABLE_UNSUPPORTED_KEYWORDS: readonly string[] = [
  ...new Set([
    ...ANTHROPIC_UNSUPPORTED_KEYWORDS,
    ...OPENAI_UNSUPPORTED_KEYWORDS,
    ...GEMINI_IGNORED_KEYWORDS,
  ]),
];

export function unsupportedKeywordsFor(provider: AiProviderId): readonly string[] {
  if (provider === 'anthropic') return ANTHROPIC_UNSUPPORTED_KEYWORDS;
  if (provider === 'openai') return OPENAI_UNSUPPORTED_KEYWORDS;
  return GEMINI_IGNORED_KEYWORDS;
}

/**
 * A single-value `enum`, which is the portable spelling of `const`.
 *
 * Written as a helper rather than inline so the reason travels with every use: `const` is
 * accepted by Anthropic, undocumented on OpenAI, and absent from Gemini's supported list.
 *
 * One thing to check before routing this schema through `@anthropic-ai/sdk`'s
 * `jsonSchemaOutputFormat` helper, which mizan deliberately does not use today: that helper's
 * transform has no branch for `enum`, so it folds the keyword into the schema's `description`
 * as prose. Going through it would demote this discriminator to a hint, which is the exact
 * failure `literal()` exists to avoid.
 */
export function literal(value: string): { enum: readonly [string] } {
  return { enum: [value] };
}
