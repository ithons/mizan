import { useId, useState, type ReactNode } from 'react';

export interface DisclosureState {
  open: boolean;
  id: string;
  toggle: () => void;
}

export function useDisclosure(): DisclosureState {
  const [open, setOpen] = useState(false);
  const id = useId();
  return { open, id, toggle: () => setOpen((value) => !value) };
}

/** The "?" beside a figure or heading that keeps its methodology off the main surface. */
export function ExplainToggle({ disclosure, label }: { disclosure: DisclosureState; label: string }) {
  return (
    <button
      type="button"
      aria-expanded={disclosure.open}
      aria-controls={disclosure.id}
      aria-label={`Explain ${label}`}
      title={`Explain ${label}`}
      onClick={disclosure.toggle}
      className={`inline-flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border text-micro transition-colors ${
        disclosure.open ? 'border-ink text-ink' : 'border-line-3 text-muted hover:border-ink hover:text-ink'
      }`}
    >
      ?
    </button>
  );
}

export function ExplainPanel({ disclosure, children }: { disclosure: DisclosureState; children: ReactNode }) {
  return (
    <div
      id={disclosure.id}
      hidden={!disclosure.open}
      className="mt-2 max-w-[66ch] space-y-1.5 text-note leading-relaxed text-muted-2"
    >
      {children}
    </div>
  );
}

/** A "?" and the text it reveals, for where the panel can sit directly under the toggle. */
export function Explain({ label, children }: { label: string; children: ReactNode }) {
  const disclosure = useDisclosure();
  return (
    <>
      <ExplainToggle disclosure={disclosure} label={label} />
      <ExplainPanel disclosure={disclosure}>{children}</ExplainPanel>
    </>
  );
}

/** A labelled section folded away by default: the details behind a page's leading reading. */
export function Details({ summary, children, className = '' }: { summary: string; children: ReactNode; className?: string }) {
  return (
    <details className={`group ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-body text-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>
        {summary}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}
