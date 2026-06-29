import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

interface ConfirmRemoveModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  isPending?: boolean;
  danger?: boolean;
}

export function ConfirmRemoveModal({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  onConfirm,
  isPending = false,
  danger = true,
}: ConfirmRemoveModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div className="flex items-start gap-2 p-3 bg-[#e07070]/10 border border-[#e07070]/30 rounded">
          <AlertTriangle size={14} className="text-[#e07070] mt-0.5 flex-shrink-0" />
          <p className="text-xs text-muted">{description}</p>
        </div>
        <div className="flex gap-3">
          <button
            className={`flex-1 py-2 text-sm font-medium rounded hover:opacity-90 disabled:opacity-40 ${
              danger
                ? 'bg-[#e07070] text-white'
                : 'bg-[#4ecba3] text-[#0f0f11]'
            }`}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? 'Working...' : confirmLabel}
          </button>
          <button
            className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
