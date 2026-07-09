interface CategoryPillProps {
  name?: string | null;
  className?: string;
}

export function CategoryPill({ name, className = '' }: CategoryPillProps) {
  const uncategorized = !name;
  return (
    <span
      className={`inline-block rounded-md border px-2 py-px text-[11.5px] leading-[18px] ${
        uncategorized
          ? 'border-pill-border bg-pill-bg text-muted-2'
          : 'border-sage-tint-border bg-sage-tint text-sage-text'
      } ${className}`}
    >
      {name ?? 'Uncategorized'}
    </span>
  );
}
