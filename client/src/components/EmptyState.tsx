import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: () => void;
  actionLabel?: string;
}

export function EmptyState({ icon: Icon, title, description, action, actionLabel }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <Icon size={36} className="text-muted opacity-30 mb-3" />
      <p className="text-sm text-muted font-medium">{title}</p>
      {description && (
        <p className="text-xs text-muted/70 mt-1 max-w-xs">{description}</p>
      )}
      {action && actionLabel && (
        <button
          onClick={action}
          className="mt-4 px-4 py-2 text-xs bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
