/**
 * Opening JSX tags, extracted whole.
 *
 * Three tests walked tags with `src.matchAll(/<[A-Za-z][^>]*>/g)` and each one silently judged a
 * subset of the app. `[^>]*` stops at the first `>` in the source, and in this codebase that is
 * routinely the `>` of an arrow function prop:
 *
 *   <textarea
 *     onChange={(e) => setDraft(e.target.value)}      <- the walk ends HERE
 *     className="... border border-line-2 bg-rail ..."  <- never seen
 *   />
 *
 * Two live contrast defects sat behind exactly that truncation and a commit claiming to have fixed
 * every one of them shipped with them still in the tree. A test that cannot see a quarter of its
 * subject reports silence as coverage, which is the failure mode this repo's third rule is about.
 *
 * Depth tracking rather than a smarter regex, because the thing that has to be counted is nesting:
 * a `>` inside `{...}` or inside a string or template is not the end of the tag.
 */
export interface JsxTag {
  /** The full opening tag, `<` through its closing `>`. */
  text: string;
  /** Offset of the `<` in the source. */
  index: number;
  /** 1-based line of the `<`. */
  line: number;
}

export function openingTags(src: string): JsxTag[] {
  const out: JsxTag[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<') continue;
    if (!/[A-Za-z]/.test(src[i + 1] ?? '')) continue;

    let depth = 0;
    let quote: string | null = null;
    let j = i + 1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        continue;
      }
      // Comments inside a tag. `NavRail` and `Modal` both open a tag and then explain the token
      // choice in a block comment before the className, and a `>` or a quote in that prose would
      // otherwise end the tag or open a string that never closes.
      if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); if (e < 0) { j = -1; break; } j = e + 1; continue; }
      if (c === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); if (e < 0) { j = -1; break; } j = e; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') { depth--; continue; }
      // A `<` at depth 0 before any `>` means this was not a tag at all (a comparison, a generic).
      if (depth === 0 && c === '>') break;
      if (depth === 0 && c === '<' && j > i + 1) { j = -1; break; }
    }
    if (j < 0 || j >= src.length) continue;
    out.push({ text: src.slice(i, j + 1), index: i, line: src.slice(0, i).split('\n').length });
    i = j;
  }
  return out;
}

/**
 * The nearest enclosing `bg-*` ground for a tag, resolved by indentation within the same file.
 *
 * A rule whose ground comes from an ancestor is invisible to a same-tag check. `DataSection.tsx`
 * draws `border-line-2` inside a `bg-rail` block opened 45 lines earlier, which is 2.92:1 and was
 * missed for that reason. Indentation rather than a real parse: this is a test helper, JSX in this
 * repo is uniformly formatted, and a wrong answer here can only ever be "no ground found", which
 * the caller is required to count and print rather than pass.
 */
export function inheritedGround(src: string, tag: JsxTag, grounds: readonly string[]): string | null {
  const lines = src.split('\n');
  const own = new RegExp(`(^|[\\s"'\`])bg-(${grounds.join('|')})\\b`).exec(tag.text);
  if (own) return own[2];

  const at = tag.line - 1;
  const indentOf = (s: string) => s.length - s.trimStart().length;
  let limit = indentOf(lines[at] ?? '');
  for (let k = at - 1; k >= 0; k--) {
    const line = lines[k];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    if (ind >= limit) continue;
    limit = ind;
    const m = new RegExp(`(^|[\\s"'\`])bg-(${grounds.join('|')})\\b`).exec(line);
    if (m) return m[2];
    if (ind === 0) break;
  }
  return null;
}
