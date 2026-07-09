import { useEffect, type RefObject } from 'react';

export function useOutsideClick(ref: RefObject<HTMLElement | null>, active: boolean, cb: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) cb();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [active, ref, cb]);
}
