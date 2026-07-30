import { useEffect, useMemo, useRef, useState } from 'react';
import type { Category } from '@shared/types';
import { useOutsideClick } from '../../lib/useOutsideClick';

interface CategoryPickerProps {
  value: string;
  /** Nested category tree (parents with children[]), as returned by categoriesApi.list(). */
  categories: Category[];
  onChange: (categoryId: string) => void;
  placeholder?: string;
  /** When false, no "clear" option (for required selections). */
  clearable?: boolean;
  /** Optional predicate to limit which categories are selectable (e.g. exclude income). */
  filter?: (c: Category) => boolean;
  align?: 'left' | 'right';
  /** 'field' = full-width bordered form control (modals); 'quiet' = text trigger (filter rows). */
  variant?: 'field' | 'quiet';
  disabled?: boolean;
  className?: string;
}

interface Row {
  id: string;
  name: string;
  color?: string | null;
  depth: number;      // 0 = top-level, 1 = child
  isParent: boolean;  // has children (renders a collapse chevron)
}

/**
 * Hierarchical, searchable category picker. Renders parent groups with indented children and a
 * type-to-filter box, instead of one long flat list. Same value contract as a plain select:
 * onChange(categoryId). Reuses the combobox/listbox pattern from Select.tsx.
 */
export function CategoryPicker({
  value, categories, onChange, placeholder = 'Category', clearable = true, filter, align = 'left', variant = 'quiet', disabled = false, className = '',
}: CategoryPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useOutsideClick(rootRef, open, () => { setOpen(false); setQuery(''); });

  const allow = (c: Category) => (filter ? filter(c) : true);

  // Flat lookup for the trigger label + color.
  const flat = useMemo(() => {
    const out: Category[] = [];
    const walk = (cs: Category[]) => cs.forEach((c) => { out.push(c); if (c.children?.length) walk(c.children); });
    walk(categories);
    return out;
  }, [categories]);
  const selected = flat.find((c) => c.id === value);

  // Visible rows: a search-filtered flat list, or the collapsible grouped tree.
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return flat
        .filter((c) => allow(c) && c.name.toLowerCase().includes(q))
        .map((c) => ({ id: c.id, name: c.name, color: c.color, depth: c.parent_id ? 1 : 0, isParent: false }));
    }
    const out: Row[] = [];
    for (const parent of categories) {
      const kids = (parent.children ?? []).filter(allow);
      const parentSelectable = allow(parent);
      if (!parentSelectable && kids.length === 0) continue;
      out.push({ id: parent.id, name: parent.name, color: parent.color, depth: 0, isParent: kids.length > 0 });
      if (!collapsed.has(parent.id)) {
        for (const kid of kids) out.push({ id: kid.id, name: kid.name, color: kid.color, depth: 1, isParent: false });
      }
    }
    return out;
  }, [categories, flat, query, collapsed, filter]);

  useEffect(() => { if (open) { setActiveIndex(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const commit = (row: Row) => { onChange(row.id); setOpen(false); setQuery(''); };
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActiveIndex((i) => Math.min(rows.length - 1, i + 1)); break;
      case 'ArrowUp': e.preventDefault(); setActiveIndex((i) => Math.max(0, i - 1)); break;
      case 'Enter': { e.preventDefault(); const r = rows[activeIndex]; if (r) commit(r); break; }
      case 'Escape': e.preventDefault(); setOpen(false); setQuery(''); break;
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button" role="combobox" aria-expanded={open} aria-haspopup="listbox" disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={variant === 'field'
          ? `mz-field flex w-full items-center justify-between gap-1.5 text-left ${value ? 'text-ink' : 'text-muted'}`
          : `flex items-center gap-1.5 text-body transition-colors ${value ? 'text-ink' : 'text-muted hover:text-ink'}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {selected && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: selected.color ?? 'var(--mz-muted-2)' }} />}
          <span className={`${variant === 'field' ? '' : 'max-w-[180px]'} truncate`}>{selected?.name ?? placeholder}</span>
        </span>
        <svg width="9" height="6" viewBox="0 0 9 6" className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>
          <path d="M1 1l3.5 3.5L8 1" fill="none" stroke="var(--mz-muted-2)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className={`absolute z-30 mt-2 w-[240px] rounded-lg border border-line-2 bg-card py-1 shadow-e2 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          <input
            ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }} onKeyDown={onKeyDown}
            placeholder="Search categories…"
            className="mx-2 mb-1 w-[calc(100%-1rem)] rounded-md bg-rail px-2.5 py-1.5 text-body text-ink placeholder:text-muted focus:outline-none"
          />
          <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto">
            {clearable && !query && (
              <div
                role="option" aria-selected={value === ''} data-index={-1}
                onMouseDown={(e) => { e.preventDefault(); commit({ id: '', name: placeholder, depth: 0, isParent: false }); }}
                className="cursor-pointer px-3 py-1.5 text-body text-muted hover:text-ink"
              >
                {placeholder}
              </div>
            )}
            {rows.length === 0 && <div className="px-3 py-2 text-body text-muted">No matches</div>}
            {rows.map((r, i) => (
              <div
                key={r.id} role="option" aria-selected={r.id === value} data-index={i}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => { e.preventDefault(); commit(r); }}
                className={`flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-body ${
                  i === activeIndex ? 'bg-rail text-ink' : 'text-ink-soft'
                } ${r.depth === 0 && r.isParent && !query ? 'font-medium text-ink' : ''}`}
                style={{ paddingLeft: `${12 + r.depth * 14}px` }}
              >
                {r.isParent && !query ? (
                  <button
                    type="button" aria-label="Toggle group"
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); toggleCollapse(r.id); }}
                    className="flex-shrink-0"
                  >
                    <svg width="8" height="6" viewBox="0 0 9 6" className={`transition-transform ${collapsed.has(r.id) ? '-rotate-90' : ''}`} aria-hidden>
                      <path d="M1 1l3.5 3.5L8 1" fill="none" stroke="var(--mz-muted-2)" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                ) : (
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: r.color ?? 'var(--mz-muted-2)' }} />
                )}
                <span className="truncate">{r.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
