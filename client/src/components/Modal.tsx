import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useOverlay, useShortcuts } from '../lib/keyboard';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}

export function Modal({ open, onClose, title, children, maxWidth = '480px' }: ModalProps) {
  /**
   * Every open dialog used to hold its own window listener for Escape, so one press closed all of
   * them at once, and none of them told the screen underneath to stop answering the keyboard: the
   * ledger compensated by naming its own three modals in a condition of its own. Registering as an
   * overlay does both jobs, and `overlay.close` reaches only the dialog on top of the stack.
   */
  const owner = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = `${owner}-title`;
  useOverlay(owner, open, panelRef);
  useShortcuts(owner, { 'overlay.close': onClose }, open);

  /**
   * Focus enters the dialog when it opens.
   *
   * Without this the dialog is announced and unreachable: focus stays on the button that opened it,
   * which is behind the scrim, so the first Tab walks the page underneath and a screen reader keeps
   * reading the screen the owner just left. The panel takes it rather than the first field, because
   * the header and the title have to be read before the form, and because six of the seven dialogs
   * that use this component open onto something other than an input.
   *
   * It is also what makes the restore in `useOverlay` mean anything: something has to take focus
   * away before giving it back is a repair.
   */
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  // Rendered through a portal to <body>, NOT in place. `.mz-screen` (the wrapper around every
  // view) keeps a persistent `transform` from its entry animation, and a transformed element
  // becomes the containing block for `position: fixed` descendants. Rendered inline, this
  // overlay therefore sized itself to the whole page: on a long list that meant an 8984px-tall
  // container with the dialog centered ~4400px down, i.e. a blurred screen with nothing on it.
  // The portal puts it outside that ancestor so `fixed` means the viewport again.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      {/* Click-to-close, and nothing else. `aria-hidden` because a screen reader announcing a
          full-screen unlabelled region ahead of the dialog is noise, and the dialog's own close
          button and Escape are the reachable ways out. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-ink/25"
        style={{ backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />
      {/* Modal */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        /* Named by its own heading. `aria-modal` without a name announces "dialog" and nothing
           else, and all seven callers already render the one true title in this header, so the
           name is there to point at rather than to invent.

           `useId` rather than a constant because this component is instantiated in seven places
           and `accounts/Accounts.tsx` alone mounts four of them in one tree. Only the open one
           renders, so a constant would not collide today; it would collide the first time two are
           open together, and nothing in the component stops that. */
        aria-labelledby={titleId}
        /* Focusable by script and not by Tab, the same pairing `CommandPalette` uses: the effect
           above puts focus here on open, and the Tab cycle in `keyboard.ts` must not offer the
           panel itself as a stop. */
        tabIndex={-1}
        /* e3, matching `Card`. A dialog is the surface that carries money, so what actually
           separates it from the page is worth stating rather than assuming.

           Not the surface step. `card-alt` on `paper` is 1.04:1 light and 1.18:1 dark, and on
           light that is under the 1.15:1 floor `tests/edgeToken.test.ts` holds a value edge to.
           The note here used to name the surface as half the mechanism, alongside a dark ground
           of L* 13.0; dark `paper` is L* 0.0 now and light `paper` is pure white, so neither half
           of that sentence survived the 2026-08-01 palette.

           Not the shadow either, on dark: `--mz-e3` there is black over a pure black page, so it
           composites to the page exactly and measures 1.00:1. On light its densest term
           composites to rgb(218 217 214) over white, 1.41:1 before any blur, which is a soft seat
           and not an edge.

           What is left is the border and the scrim, and between them they are enough. `line-3`
           on `card-alt` is 4.74:1 light and 4.88:1 dark, the same edge `Card` names for its own
           e3 rung. The scrim is this component's alone, which no elevation rung has: `bg-ink/25`
           composites to rgb(191 191 191) on light and rgb(64 64 64) on dark, and the dialog
           surface stands off it at 1.76:1 and 1.71:1 respectively. Every figure here was
           re-derived from client/src/index.css on 2026-08-01. */
        className="relative flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-xl border border-line-3 bg-card-alt shadow-e3 focus:outline-none"
        style={{ maxWidth }}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-line px-6 py-4">
          <h2 id={titleId} className="font-serif text-title text-ink">{title}</h2>
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
