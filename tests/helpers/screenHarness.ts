import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { AdvisorChatProvider } from '../../client/src/hooks/advisorChat';

/**
 * Any screen, rendered on the server with its cache seeded, the way `instrumentHarness` and
 * `planHarness` render theirs. `renderToString` runs no effects, so a key left unseeded is a
 * pending query that fires no request; `unseeded` is returned so a caller can assert it seeded
 * every key the screen asked for, because a pending key is a skeleton that can hide a panel.
 */
export interface ScreenRender {
  html: string;
  unseeded: string[];
}

export function renderScreen(
  screen: ComponentType,
  path: string,
  seed: ReadonlyArray<readonly [QueryKey, unknown]>
): ScreenRender {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity } },
  });
  for (const [key, data] of seed) client.setQueryData(key, data);

  const realError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return;
    realError(...args);
  };
  try {
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(AdvisorChatProvider, null, createElement(screen))
        )
      )
    );
    const unseeded = client
      .getQueryCache()
      .getAll()
      .filter((q) => q.state.data === undefined && q.state.status !== 'error')
      .map((q) => JSON.stringify(q.queryKey));
    return { html, unseeded };
  } finally {
    console.error = realError;
  }
}

/** `negative` and `warning` are the legacy aliases `index.css` binds to clay's and gold's triplets. */
const ALIAS: Record<string, string> = { negative: 'clay', warning: 'gold' };
const FAMILY = '(clay|gold|estimate|review|sage|negative|warning)';
const UTILITY = new RegExp(
  `^(?:text|bg|border(?:-[lrtbxy])?|fill|stroke|ring|outline|divide|decoration|from|via|to|shadow)-${FAMILY}(?:-[\\w-]+)?(?:/\\d+)?$`
);
const INLINE = new RegExp(`var\\(--(?:mz|color)-${FAMILY}`, 'g');
/** Breakpoint and theme prefixes still paint at rest; an interaction prefix does not. */
const AT_REST = /^(?:(?:sm|md|lg|xl|2xl|dark):)*/;

/**
 * The markup without any polygon its clip leaves no area.
 *
 * `TrendChart` draws every fill twice, sage clipped above the zero line and clay clipped below it,
 * so a series that never crosses zero still emits a clay polygon. Its lowest edge is the zero line
 * and its clip begins there, so the two share an edge and nothing is painted. Counting it would
 * make every chart on every screen read as a loss.
 */
function withoutEmptyClips(html: string): string {
  const clips = new Map<string, [number, number]>();
  for (const [, id, y, height] of html.matchAll(/<clipPath id="([^"]+)"><rect [^>]*?y="([^"]+)"[^>]*?height="([^"]+)"/g)) {
    clips.set(id, [Number(y), Number(y) + Number(height)]);
  }
  return html.replace(
    /<polygon points="([^"]+)"[^>]*clip-path="url\(#([^)]+)\)"[^>]*>(?:<\/polygon>)?/g,
    (whole, points: string, id: string) => {
      const clip = clips.get(id);
      if (!clip) return whole;
      const ys = points.trim().split(/\s+/).map((pair) => Number(pair.split(',')[1]));
      const overlap = Math.min(Math.max(...ys), clip[1]) - Math.max(Math.min(...ys), clip[0]);
      return overlap < 0.01 ? '' : whole;
    }
  );
}

/**
 * Every chromatic family the markup carries at rest, sage included.
 *
 * Read from class attributes token by token and from inline `var(--mz-*)` references, because the
 * charts set their ink through SVG attributes and style props that never pass through Tailwind. A
 * token behind `hover:` or `focus:` is not on screen until the owner reaches for it, so the delete
 * affordance that turns clay under the pointer is not counted.
 */
export function familiesIn(markup: string): string[] {
  const html = withoutEmptyClips(markup);
  const found = new Set<string>();
  const add = (family: string) => found.add(ALIAS[family] ?? family);
  for (const [, classes] of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of classes.split(/\s+/)) {
      const bare = token.replace(AT_REST, '');
      if (bare.includes(':')) continue;
      const match = UTILITY.exec(bare.replace(/^!/, ''));
      if (match) add(match[1]);
    }
  }
  for (const [, family] of html.matchAll(INLINE)) add(family);
  return [...found].sort();
}

/** The alarm families on screen: clay, gold, estimate and review. */
export function raisedIn(html: string): string[] {
  return familiesIn(html).filter((f) => f !== 'sage');
}
