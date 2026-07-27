import { useEffect, useRef, useState } from 'react';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Eases toward `target` the way a balance beam finds equilibrium: it swings past, comes back,
 * and settles. An exponentially damped cosine, so the overshoot decays rather than ringing.
 *
 * Replaces a plain cubic-out ease, which arrives and stops dead. That is right for a number
 * counting up and wrong for something with weight hanging off both ends.
 */
export function useSettledValue(target: number, durationMs = 1500): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (prefersReducedMotion() || durationMs <= 0) {
      setValue(target);
      return;
    }
    const from = valueRef.current;
    if (from === target) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // ~6% overshoot on the first swing, effectively at rest by t=1.
      const eased = 1 - Math.exp(-7 * t) * Math.cos(8 * t);
      setValue(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setValue(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}
