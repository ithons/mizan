import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}

export function Modal({ open, onClose, title, children, maxWidth = '480px' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  // Rendered through a portal to <body>, NOT in place. `.mz-screen` (the wrapper around every
  // view) keeps a persistent `transform` from its entry animation, and a transformed element
  // becomes the containing block for `position: fixed` descendants. Rendered inline, this
  // overlay therefore sized itself to the whole page — on a long list that meant an 8984px-tall
  // container with the dialog centered ~4400px down, i.e. a blurred screen with nothing on it.
  // The portal puts it outside that ancestor so `fixed` means the viewport again.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-ink/25"
        style={{ backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />
      {/* Modal */}
      <div
        className="relative flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-xl border border-line-2 bg-card shadow-e3"
        style={{ maxWidth }}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-line px-6 py-4">
          <h2 className="font-serif text-title text-ink">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted transition-colors hover:bg-well hover:text-ink active:translate-y-px"
          >
            <X size={18} />
          </button>
        </div>
        {/* Content scrolls; the panel is capped to the viewport. Without this a tall form was
            clipped off both edges of the screen with no way to reach the submit button. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}
