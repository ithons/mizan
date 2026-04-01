import React from 'react';

interface CategoryBadgeProps {
  name: string;
  color?: string | null;
  icon?: string | null;
  size?: 'sm' | 'md';
}

export function CategoryBadge({ name, color, icon, size = 'sm' }: CategoryBadgeProps) {
  const dotSize = size === 'sm' ? 'w-2 h-2' : 'w-3 h-3';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';

  return (
    <span className={`inline-flex items-center gap-1.5 ${textSize} text-muted`}>
      <span
        className={`${dotSize} rounded-full flex-shrink-0`}
        style={{ backgroundColor: color || '#6b6b7a' }}
      />
      {icon && <span className="text-xs">{icon}</span>}
      <span className="text-text">{name}</span>
    </span>
  );
}
