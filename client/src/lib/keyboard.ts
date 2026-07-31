import { useEffect, useRef } from 'react';

/**
 * The keyboard has one owner.
 *
 * Before this file there were three window-level `keydown` listeners, plus one per mounted `Modal`,
 * and each decided on its own whether a keystroke was its business. That shape produced the same
 * defect twice from two directions:
 *
 *   `g` then `a` navigated to /accounts AND accepted the AI draft under the ledger's cursor. The
 *   rail's chord called `preventDefault()`, which is not `stopImmediatePropagation()`, so the
 *   ledger's own listener ran on the same dispatch and wrote to the database.
 *
 *   With the ⌘K sheet open in `digest` mode, the button that set the mode unmounts, focus falls
 *   back to `document.body`, and the ledger's focus test answered "nothing is focused, this key is
 *   mine". `a` applied an AI draft while the owner was reading the record of what the AI had
 *   already done.
 *
 * Both are the same bug: N listeners each answering "is this mine?" with N different local rules,
 * where a keystroke can be claimed twice and no rule can see what another one is doing. A fourth
 * guard on a fourth listener would produce the third instance. So there is one listener, one
 * resolver, and one table of every chord this app takes.
 *
 * The three questions the resolver answers, which no single listener could:
 *
 *   WHAT IS OPEN. `overlays` is a stack. A `screen` binding is inert while ANY overlay is open,
 *   because an overlay is by definition covering the screen those keys belong to. That is
 *   structural: the ledger no longer tests for open modals or open sheets, and cannot be wrong
 *   about a sheet it does not know exists.
 *
 *   WHAT HAS FOCUS. One focus rule per binding rather than one per listener. A bare letter that
 *   writes requires focus to be on the page itself (`page`); the navigation prefix only requires
 *   that you are not typing (`not-typing`); a modifier chord fires anywhere.
 *
 *   WHOSE KEYSTROKE IT IS. A prefix that is armed owns the next keystroke outright, whether or not
 *   the pair names anything. That single rule is what makes `g` `a` navigate and write nothing:
 *   the `a` is spent by the chord before any bare binding is consulted.
 *
 * `resolveKeystroke` is pure and takes the whole scene as data, so every claim above is driven
 * directly by `tests/keyboard.test.ts` rather than asserted about source text.
 */

// ─── The table ────────────────────────────────────────────────────────────────

/**
 * Which surface a chord belongs to.
 *
 * `app`      the app's own chrome. Survives an overlay, because ⌘K has to be able to close the
 *            sheet it opened.
 * `screen`   the route view underneath. Dead the moment anything covers it.
 * `overlay`  a sheet or a dialog. Runs only for the overlay currently on top of the stack, so two
 *            stacked dialogs do not both close on one Escape.
 */
export type ShortcutLayer = 'app' | 'screen' | 'overlay';

/** Where focus has to be for a binding to fire. */
export type FocusRule = 'anywhere' | 'not-typing' | 'page';

export interface Shortcut {
  readonly id: string;
  /**
   * Canonical form: `mod+k` for a modifier chord, `escape` or `a` for a single key, `g b` for a
   * prefixed pair. Lower case, because `readKeystroke` lower-cases what the browser reports.
   */
  readonly chord: string;
  readonly layer: ShortcutLayer;
  readonly focus: FocusRule;
  /** What the owner is told this key does. The rail and the ledger print this table, not copies. */
  readonly describes: string;
}

/**
 * Every keystroke this app takes, in one place, because a claim nobody can enumerate is a claim
 * nobody can check for a collision. Adding a shortcut means adding a row here, and a row that
 * collides with one already on the list throws at import time (see `assertNoCollisions`).
 *
 * Modifier chords are deliberately almost absent. ⌘1 to ⌘9 switch browser tabs, ⌘0 resets zoom, ⌘R
 * reloads, ⌘P prints, ⌘S saves the page; every one of those was once being taken by a screen here.
 * ⌘K is the single deliberate hijack, and navigation moved to a `g` prefix, which owns nothing and
 * so takes nothing from anyone.
 */
export const SHORTCUTS = [
  {
    id: 'palette.toggle',
    chord: 'mod+k',
    layer: 'app',
    focus: 'anywhere',
    describes: 'Open or close the command sheet',
  },
  { id: 'nav.balance', chord: 'g b', layer: 'app', focus: 'not-typing', describes: 'Go to Balance' },
  { id: 'nav.ledger', chord: 'g l', layer: 'app', focus: 'not-typing', describes: 'Go to Ledger' },
  { id: 'nav.accounts', chord: 'g a', layer: 'app', focus: 'not-typing', describes: 'Go to Accounts' },
  { id: 'nav.investments', chord: 'g i', layer: 'app', focus: 'not-typing', describes: 'Go to Investments' },
  { id: 'nav.plan', chord: 'g p', layer: 'app', focus: 'not-typing', describes: 'Go to Plan' },
  { id: 'nav.settings', chord: 'g s', layer: 'app', focus: 'not-typing', describes: 'Go to Settings' },
  {
    id: 'ledger.nextSuggestion',
    chord: 'j',
    layer: 'screen',
    focus: 'page',
    describes: 'Move to the next suggestion',
  },
  {
    id: 'ledger.prevSuggestion',
    chord: 'k',
    layer: 'screen',
    focus: 'page',
    describes: 'Move to the previous suggestion',
  },
  {
    id: 'ledger.acceptSuggestion',
    chord: 'a',
    layer: 'screen',
    focus: 'page',
    describes: 'Accept the suggestion under the cursor',
  },
  {
    id: 'ledger.dismissSuggestion',
    chord: 'x',
    layer: 'screen',
    focus: 'page',
    describes: 'Drop the suggestion under the cursor',
  },
  {
    id: 'overlay.close',
    chord: 'escape',
    layer: 'overlay',
    focus: 'anywhere',
    describes: 'Close what is open',
  },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

/** How long a prefix waits for its second key before giving the keyboard back to the page. */
export const CHORD_WINDOW_MS = 1200;

const CHORD_GRAMMAR = /^(?:mod\+)?[a-z0-9]+(?: [a-z0-9]+)?$/;

/**
 * The collision check, run over the table at import time.
 *
 * Exported so a test can drive it over a table that DOES collide: the guarantee being made is that
 * a future screen claiming a taken chord fails loudly, and that guarantee is worth exactly as much
 * as the proof that the failure happens.
 *
 * An `app` chord and a `screen` chord may not be the same string, even though the layers are
 * ordered and the screen would simply win: a screen silently shadowing the app's own chrome is the
 * theft this file exists to make impossible. An `overlay` may shadow either, because covering the
 * surface underneath is what an overlay is.
 */
export function assertNoCollisions(table: readonly Shortcut[]): void {
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const s of table) {
    if (ids.has(s.id)) throw new Error(`shortcut id "${s.id}" is declared twice`);
    ids.add(s.id);
    if (!CHORD_GRAMMAR.test(s.chord)) {
      throw new Error(`shortcut "${s.id}" has chord "${s.chord}", which is not a canonical chord`);
    }
    const space = s.chord.indexOf(' ');
    if (space > -1) prefixes.add(s.chord.slice(0, space));
  }

  const claimed = new Map<string, Shortcut>();
  for (const s of table) {
    if (prefixes.has(s.chord)) {
      throw new Error(
        `shortcut "${s.id}" claims "${s.chord}", which is already the prefix of a chord and cannot ` +
          `also be a shortcut of its own: the prefix spends the next keystroke`
      );
    }
    // Overlays are allowed to shadow, and are allowed to share a chord with each other because only
    // the topmost open one is ever dispatched to.
    const scope = s.layer === 'overlay' ? 'overlay' : 'page';
    const key = `${scope}:${s.chord}`;
    const taken = claimed.get(key);
    if (taken && !(s.layer === 'overlay' && taken.layer === 'overlay')) {
      throw new Error(
        `shortcut "${s.id}" (${s.layer}) claims "${s.chord}", already claimed by "${taken.id}" (${taken.layer})`
      );
    }
    if (!taken) claimed.set(key, s);
  }
}

assertNoCollisions(SHORTCUTS);

const BY_ID: ReadonlyMap<string, Shortcut> = new Map(SHORTCUTS.map((s) => [s.id, s]));

export function shortcut(id: ShortcutId): Shortcut {
  const found = BY_ID.get(id);
  // Unreachable through the type, and thrown rather than defaulted so a table edit that breaks the
  // map cannot degrade into a shortcut that silently never fires.
  if (!found) throw new Error(`no shortcut named "${id}"`);
  return found;
}

/** The chord as the owner is shown it, e.g. `g a`. One source for the hint text on every screen. */
export function chordOf(id: ShortcutId): string {
  return shortcut(id).chord;
}

// ─── Where focus is ───────────────────────────────────────────────────────────

/**
 * The slice of the focused element the resolver reads, kept as data so it can be driven by a test.
 * `readFocusedElement` is the only thing in this file that touches the DOM.
 */
export interface FocusedElement {
  tagName: string;
  /** The `role` ATTRIBUTE, not the reflected property: the attribute is what every browser has. */
  role: string | null;
  tabIndex: number;
  isContentEditable: boolean;
}

/**
 * Tags that are controls whatever else they say about themselves.
 *
 * `OPTION` is here because a listbox option can hold focus in some browsers, and `SUMMARY` and
 * `DETAILS` because they are operable without any role or tabindex.
 */
const CONTROL_TAGS = new Set([
  'A',
  'AREA',
  'BUTTON',
  'DETAILS',
  'INPUT',
  'OPTION',
  'SELECT',
  'SUMMARY',
  'TEXTAREA',
]);

/** Roles that mean "the owner is operating this", including every role a custom widget adopts. */
const CONTROL_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/**
 * Whether a bare letter belongs to the page rather than to whatever has focus.
 *
 * The guard this replaces was a tagName allowlist, `['INPUT','TEXTAREA','SELECT']`, and it had a
 * hole wide enough to write through. `components/balance/Select` renders a `<button
 * role="combobox">`, whose tagName is BUTTON: focusing the ledger's account filter or its range
 * control and pressing `a` confirmed the AI draft under the cursor and wrote it, and `x` dismissed
 * it. Every filter chip, every Skip button, every row's select circle and the row's own Accept and
 * Dismiss buttons had the same hole, so `x` pressed twice dismissed a second draft.
 *
 * A tagName list is the wrong shape because the question is not which element it is. It is whether
 * focus rests on a control at all. Anything focusable is something the owner is operating; a bare
 * letter means something only when focus is on the page itself, which is where it sits while the
 * owner is reading. Focus lands ON the control rather than inside it, so this needs no ancestor
 * walk, with the one exception of `contenteditable`, which every descendant inherits.
 *
 * This answers only "where is focus". It does NOT answer "is anything covering this screen", which
 * is the question the `digest` sheet got wrong, and which the layer rule in `resolveKeystroke`
 * answers instead.
 */
export function focusIsOnThePage(el: FocusedElement | null): boolean {
  if (!el) return true;
  if (el.isContentEditable) return false;
  if (CONTROL_TAGS.has(el.tagName.toUpperCase())) return false;
  if (el.role !== null && CONTROL_ROLES.has(el.role.trim().toLowerCase())) return false;
  // A deliberate tabindex is the author saying "this is operable". `document.body` and every plain
  // element report -1, which is how "nothing is focused" reaches here.
  return el.tabIndex < 0;
}

/** The narrower question the navigation prefix asks: are the letters going into a field? */
export function focusIsTyping(el: FocusedElement | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName.toUpperCase());
}

export function readFocusedElement(target: EventTarget | null): FocusedElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return {
    tagName: target.tagName,
    role: target.getAttribute('role'),
    tabIndex: target.tabIndex,
    isContentEditable: target.isContentEditable,
  };
}

function focusAllows(rule: FocusRule, el: FocusedElement | null): boolean {
  switch (rule) {
    case 'anywhere':
      return true;
    case 'not-typing':
      return !focusIsTyping(el);
    case 'page':
      return focusIsOnThePage(el);
  }
}

// ─── The resolver ─────────────────────────────────────────────────────────────

export interface BindingRef {
  id: ShortcutId;
  /** Who registered it. For an overlay binding, the same string the overlay stack carries. */
  owner: string;
}

export interface KeyboardScene<B extends BindingRef = BindingRef> {
  /** Every binding currently mounted and enabled. */
  bindings: readonly B[];
  /** Open overlays in the order they opened. The last is the one on top. */
  overlays: readonly string[];
  /** The prefix already pressed and still inside its window, or null. */
  armedPrefix: string | null;
  focus: FocusedElement | null;
}

export interface Keystroke {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

/**
 * `armed` is the prefix in force AFTER this keystroke, so the caller never decides that for itself.
 * `run` and `spend` are the two outcomes that consume the keystroke.
 */
export type Resolution<B extends BindingRef = BindingRef> =
  | { kind: 'run'; binding: B; armed: null }
  | { kind: 'arm'; armed: string }
  | { kind: 'spend'; armed: null }
  | { kind: 'pass'; armed: string | null };

const LAYER_ORDER: Record<ShortcutLayer, number> = { overlay: 0, screen: 1, app: 2 };

/** Keys that are only ever half of something else. They must not disarm a waiting prefix. */
const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'capslock', 'altgraph']);

function pick<B extends BindingRef>(scene: KeyboardScene<B>, chord: string): B | null {
  const top = scene.overlays.length > 0 ? scene.overlays[scene.overlays.length - 1] : null;
  let best: { binding: B; rank: number } | null = null;
  for (const binding of scene.bindings) {
    const s = shortcut(binding.id);
    if (s.chord !== chord) continue;
    // The layer rule, stated once. A screen's keys belong to a screen nothing is covering.
    if (s.layer === 'screen' && top !== null) continue;
    if (s.layer === 'overlay' && binding.owner !== top) continue;
    if (!focusAllows(s.focus, scene.focus)) continue;
    const rank = LAYER_ORDER[s.layer];
    if (!best || rank < best.rank) best = { binding, rank };
  }
  return best ? best.binding : null;
}

export function resolveKeystroke<B extends BindingRef>(
  scene: KeyboardScene<B>,
  stroke: Keystroke
): Resolution<B> {
  const key = stroke.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return { kind: 'pass', armed: scene.armedPrefix };

  const mod = Boolean(stroke.meta || stroke.ctrl);
  const armed = mod || stroke.alt ? null : scene.armedPrefix;

  if (armed !== null) {
    // THE RULE THAT FIXES `g` `a`. An armed prefix owns this keystroke whether or not the pair
    // names anything, so no bare binding can also see it. A chord that misses is a chord that
    // missed, not a free letter handed to whatever screen is underneath.
    const hit = pick(scene, `${armed} ${key}`);
    return hit ? { kind: 'run', binding: hit, armed: null } : { kind: 'spend', armed: null };
  }

  // Alt belongs to the browser and the OS; nothing here claims it.
  if (stroke.alt) return { kind: 'pass', armed: null };

  const hit = pick(scene, mod ? `mod+${key}` : key);
  if (hit) return { kind: 'run', binding: hit, armed: null };

  if (!mod && canArm(scene, key)) return { kind: 'arm', armed: key };
  return { kind: 'pass', armed: null };
}

/** A prefix arms only if a chord it starts could actually run, so it never swallows a dead letter. */
function canArm<B extends BindingRef>(scene: KeyboardScene<B>, key: string): boolean {
  const top = scene.overlays.length > 0 ? scene.overlays[scene.overlays.length - 1] : null;
  return scene.bindings.some((binding) => {
    const s = shortcut(binding.id);
    if (!s.chord.startsWith(`${key} `)) return false;
    if (s.layer === 'screen' && top !== null) return false;
    if (s.layer === 'overlay' && binding.owner !== top) return false;
    return focusAllows(s.focus, scene.focus);
  });
}

// ─── The one listener ─────────────────────────────────────────────────────────

interface LiveBinding extends BindingRef {
  run: () => void;
}

const bindings: LiveBinding[] = [];
const overlays: string[] = [];
let armedPrefix: string | null = null;
let armedAt = 0;

function handleKeyDown(e: KeyboardEvent): void {
  // An element handler that already acted keeps its keystroke. `components/balance/Select` consumes
  // arrows and typeahead letters this way, and a global that ran anyway would be the second claimant
  // this file exists to remove.
  if (e.defaultPrevented) return;

  const scene: KeyboardScene<LiveBinding> = {
    bindings,
    overlays,
    armedPrefix: armedPrefix !== null && Date.now() - armedAt < CHORD_WINDOW_MS ? armedPrefix : null,
    focus: readFocusedElement(e.target),
  };
  const resolution = resolveKeystroke(scene, {
    key: e.key,
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
  });

  // The clock starts when the prefix does. A keystroke that merely leaves it in force (Shift, on
  // the way to a capital) must not extend the window it is waiting inside.
  if (resolution.armed !== armedPrefix) armedAt = resolution.armed === null ? 0 : Date.now();
  armedPrefix = resolution.armed;

  if (resolution.kind === 'run') {
    e.preventDefault();
    resolution.binding.run();
  } else if (resolution.kind === 'spend') {
    e.preventDefault();
  }
}

let listening = 0;

function listen(): () => void {
  if (listening === 0) window.addEventListener('keydown', handleKeyDown);
  listening += 1;
  return () => {
    listening -= 1;
    if (listening === 0) window.removeEventListener('keydown', handleKeyDown);
  };
}

export type ShortcutHandlers = Partial<Record<ShortcutId, () => void>>;

/**
 * Claim shortcuts for as long as this component is mounted and `enabled`.
 *
 * `owner` names the surface, and for an overlay it must be the same string passed to `useOverlay`,
 * because that is how the resolver decides which of two stacked dialogs an Escape belongs to.
 *
 * Two mounted owners claiming the same non-overlay shortcut throws. The table already makes a
 * duplicate CHORD impossible; this catches the other half, two surfaces both answering to one
 * meaning, which is the ambiguity that has to be resolved by whoever wrote the second one.
 */
export function useShortcuts(owner: string, handlers: ShortcutHandlers, enabled = true): void {
  // Handler identities change on every render by construction: the ledger's close over mutation
  // objects that react-query rebuilds each time. Registering through a ref means the effect
  // re-runs only when the SET of claimed shortcuts changes, not on every keystroke-adjacent render.
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  const claimed = Object.keys(handlers).sort().join(' ');
  useEffect(() => {
    if (!enabled || claimed === '') return;
    const ids = claimed.split(' ') as ShortcutId[];
    const mine: LiveBinding[] = ids.map((id) => ({
      id,
      owner,
      run: () => latest.current[id]?.(),
    }));

    // Checked before anything is pushed, so a surface that throws leaves no half-registered claim
    // behind: its cleanup will not run.
    for (const binding of mine) {
      const clash = bindings.find(
        (b) => b.id === binding.id && b.owner !== owner && shortcut(b.id).layer !== 'overlay'
      );
      if (clash) {
        throw new Error(
          `"${owner}" claims shortcut "${binding.id}", already claimed by "${clash.owner}"`
        );
      }
    }
    bindings.push(...mine);
    const stop = listen();

    return () => {
      for (const binding of mine) {
        const at = bindings.indexOf(binding);
        if (at > -1) bindings.splice(at, 1);
      }
      stop();
    };
  }, [owner, claimed, enabled]);
}

/**
 * Declare that this surface is covering the screen.
 *
 * This is the whole of what a sheet or a dialog has to do to make the screen underneath stop
 * answering the keyboard. The screen is not asked and does not know: the ledger used to carry
 * `showAddEntry || showAddScheduled || editing` and could only ever enumerate the overlays it had
 * heard of, which is why the ⌘K sheet reached straight past it.
 */
export function useOverlay(owner: string, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    overlays.push(owner);
    return () => {
      const at = overlays.lastIndexOf(owner);
      if (at > -1) overlays.splice(at, 1);
    };
  }, [owner, open]);
}

/** The live scene, for assertions in a browser console. Not a subscription and not for rendering. */
export function readKeyboardScene(): { bindings: BindingRef[]; overlays: string[] } {
  return {
    bindings: bindings.map(({ id, owner }) => ({ id, owner })),
    overlays: [...overlays],
  };
}
