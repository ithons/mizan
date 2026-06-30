import { useEffect } from 'react';

export function useOutsideClick(ref: React.RefObject<HTMLElement | null>, active: boolean, cb: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) cb();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [active, ref, cb]);
}

export function errorMessage(err: unknown, fallback: string) { return err instanceof Error && err.message ? err.message : fallback; }
