import React, { useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { Category } from '@shared/types';
import { CategoryBadge } from '../../components/CategoryBadge';

export type SortCol = 'date' | 'amount' | 'merchant';
export type SortDir = 'asc' | 'desc';

export function SortableHeader({
  label,
  col,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortCol;
  sortBy: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
}) {
  const active = sortBy === col;

  return (
    <th
      className="text-left px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider cursor-pointer select-none hover:text-text"
      onClick={() => onSort(col)}
    >
      <span className="flex items-center gap-1">
        {label}
        {active ? (
          sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />
        ) : (
          <ChevronDown size={11} className="opacity-0 group-hover:opacity-30" />
        )}
      </span>
    </th>
  );
}

export function CategoryDropdown({
  value,
  categories,
  onChange,
}: {
  value: string | null | undefined;
  categories: Category[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = categories.find((category) => category.id === value);

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1 hover:opacity-80"
        onClick={() => setOpen(!open)}
      >
        {selected ? (
          <CategoryBadge name={selected.name} color={selected.color} icon={selected.icon} />
        ) : (
          <span className="text-xs text-muted">Uncategorized</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-6 bg-surface shadow-sm border border-border rounded shadow-xl z-30 w-52 max-h-64 overflow-y-auto">
          {categories.map((category) => (
            <button
              key={category.id}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-white/5 text-left"
              onClick={() => { onChange(category.id); setOpen(false); }}
            >
              <CategoryBadge name={category.name} color={category.color} icon={category.icon} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BulkCategoryDropdown({
  categories,
  onSelect,
}: {
  categories: Category[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1 text-xs border border-border rounded px-2 py-1 text-text hover:bg-white/5"
        onClick={() => setOpen(!open)}
      >
        Assign Category <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute left-0 top-7 bg-surface shadow-sm border border-border rounded shadow-xl z-30 w-52 max-h-64 overflow-y-auto">
          {categories.map((category) => (
            <button
              key={category.id}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-white/5 text-left"
              onClick={() => { onSelect(category.id); setOpen(false); }}
            >
              <CategoryBadge name={category.name} color={category.color} icon={category.icon} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1 text-xs bg-border/60 text-text px-2 py-0.5 rounded-full">
      {label}
      <button onClick={onRemove} className="text-muted hover:text-text">
        <X size={10} />
      </button>
    </span>
  );
}
