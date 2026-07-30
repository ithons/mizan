import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutsideClick } from '../../lib/useOutsideClick';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Shown as the trigger label when value is '' (and as the first, clearing option). */
  placeholder: string;
  /** When false, no empty "clear" option is prepended (for always-set values like ranges). */
  clearable?: boolean;
  align?: 'left' | 'right';
  className?: string;
}

/**
 * Quiet text-trigger select: reads as a text control in the filters row,
 * opens a card listbox. Full keyboard support; focus stays on the trigger.
 */
export function Select({ value, options, onChange, placeholder, clearable = true, align = 'left', className = '' }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ buffer: '', at: 0 });

  const allOptions = useMemo<SelectOption[]>(
    () => (clearable ? [{ value: '', label: placeholder }, ...options] : options),
    [options, placeholder, clearable]
  );
  const selected = allOptions.find((o) => o.value === value);

  useOutsideClick(rootRef, open, () => setOpen(false));

  useEffect(() => {
    if (open) {
      const idx = allOptions.findIndex((o) => o.value === value);
      setActiveIndex(idx >= 0 ? idx : 0);
    }
  }, [open, value, allOptions]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const commit = (index: number) => {
    const option = allOptions[index];
    if (option) onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(allOptions.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(allOptions.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      default: {
        if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
        const now = Date.now();
        const t = typeahead.current;
        t.buffer = now - t.at < 500 ? t.buffer + e.key.toLowerCase() : e.key.toLowerCase();
        t.at = now;
        const idx = allOptions.findIndex((o) => o.label.toLowerCase().replace(/^· /, '').startsWith(t.buffer));
        if (idx >= 0) setActiveIndex(idx);
      }
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className={`flex items-center gap-1.5 text-body transition-colors ${
          value ? 'text-ink' : 'text-muted hover:text-ink'
        }`}
      >
        <span className="max-w-[180px] truncate">{selected?.label ?? placeholder}</span>
        <svg width="9" height="6" viewBox="0 0 9 6" className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>
          <path d="M1 1l3.5 3.5L8 1" fill="none" stroke="var(--mz-muted-2)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className={`absolute z-30 mt-2 max-h-72 min-w-[200px] overflow-y-auto rounded-lg border border-line-2 bg-card py-1 shadow-e2 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {allOptions.map((o, i) => (
            <div
              key={`${o.value}:${o.label}`}
              role="option"
              aria-selected={o.value === value}
              data-index={i}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(i);
              }}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-body ${
                i === activeIndex ? 'bg-rail text-ink' : 'text-ink-soft'
              }`}
            >
              <span className={`h-1 w-1 flex-shrink-0 rounded-full ${o.value === value ? 'bg-sage' : 'bg-transparent'}`} />
              <span className="truncate">{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
