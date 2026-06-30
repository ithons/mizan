import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: () => void;
  actionLabel?: string;
  secondaryAction?: () => void;
  secondaryActionLabel?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  actionLabel,
  secondaryAction,
  secondaryActionLabel,
}: EmptyStateProps) {
  const hasActions = Boolean((action && actionLabel) || (secondaryAction && secondaryActionLabel));

  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <Icon size={36} className="text-muted opacity-30 mb-3" />
      <p className="text-sm text-muted font-medium">{title}</p>
      {description && (
        <p className="text-xs text-muted/70 mt-1 max-w-xs">{description}</p>
      )}
      {hasActions && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action && actionLabel && (
            <button
              onClick={action}
              className="px-4 py-2 text-xs bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90"
            >
              {actionLabel}
            </button>
          )}
          {secondaryAction && secondaryActionLabel && (
            <button
              onClick={secondaryAction}
              className="px-4 py-2 text-xs border border-border text-muted rounded hover:text-text hover:border-muted"
            >
              {secondaryActionLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
