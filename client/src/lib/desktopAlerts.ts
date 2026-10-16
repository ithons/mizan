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

/** Alerts only for ids that arrive after the first load, so opening the app never alerts. */
export function useDesktopAlerts(unread: readonly AppNotification[] | undefined, enabled: boolean): void {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!unread) return;
    if (seen.current === null) {
      seen.current = new Set(unread.map((n) => n.id));
      return;
    }
    const fresh = unread.filter((n) => !seen.current?.has(n.id));
    for (const n of unread) seen.current.add(n.id);
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
