import { useEffect, useRef, useState } from 'react';
import type { AppNotification } from '@shared/types';

const STORAGE_KEY = 'mizan.desktopAlerts';

export function desktopAlertsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function readDesktopAlertsEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1' && desktopAlertsSupported() && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

function writeDesktopAlertsEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('Could not store the desktop alerts preference', err);
  }
  window.dispatchEvent(new Event('mizan:desktop-alerts'));
}

export type DesktopAlertsState = 'unsupported' | 'blocked' | 'off' | 'on';

function currentState(): DesktopAlertsState {
  if (!desktopAlertsSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return readDesktopAlertsEnabled() ? 'on' : 'off';
}

/** Permission is only ever requested from `enable`, which must be called from a click. */
export function useDesktopAlertsPreference(): {
  state: DesktopAlertsState;
  enable: () => Promise<void>;
  disable: () => void;
} {
  const [state, setState] = useState<DesktopAlertsState>(currentState);
  useEffect(() => {
    const refresh = () => setState(currentState());
    window.addEventListener('mizan:desktop-alerts', refresh);
    return () => window.removeEventListener('mizan:desktop-alerts', refresh);
  }, []);
  return {
    state,
    enable: async () => {
      if (!desktopAlertsSupported()) return;
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      writeDesktopAlertsEnabled(permission === 'granted');
      setState(currentState());
    },
    disable: () => {
      writeDesktopAlertsEnabled(false);
      setState(currentState());
    },
  };
}

/** How far before page load a notification may be stamped and still count as new: a sync that began just before. */
const LOAD_GRACE_MS = 10 * 60_000;

/**
 * Alerts once for each notification this page did not see on its first load and that is no older
 * than shortly before the load, so opening the app never alerts and an older unread one scrolling
 * into the capped list is not mistaken for new.
 */
export function useDesktopAlerts(unread: readonly AppNotification[] | undefined, enabled: boolean): void {
  const cutoff = useRef(new Date(Date.now() - LOAD_GRACE_MS).toISOString());
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!unread) return;
    if (known.current === null) {
      known.current = new Set(unread.map((n) => n.id));
      return;
    }
    const fresh = unread.filter((n) => !known.current?.has(n.id) && n.created_at > cutoff.current);
    for (const n of unread) known.current.add(n.id);
    if (!enabled || !readDesktopAlertsEnabled()) return;
    for (const n of fresh) {
      try {
        new Notification(n.title, { body: n.body, tag: n.id });
      } catch (err) {
        console.warn('Could not show a desktop alert', err);
      }
    }
  }, [unread, enabled]);
}
