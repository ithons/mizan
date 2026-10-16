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

/**
 * Alerts only for notifications created after this page loaded, once each, so opening the app
 * never alerts and an older unread one scrolling into the capped list is not mistaken for new.
 */
export function useDesktopAlerts(unread: readonly AppNotification[] | undefined, enabled: boolean): void {
  const loadedAt = useRef(new Date().toISOString());
  const alerted = useRef(new Set<string>());
  useEffect(() => {
    if (!unread || !enabled || !readDesktopAlertsEnabled()) return;
    for (const n of unread) {
      if (n.created_at <= loadedAt.current || alerted.current.has(n.id)) continue;
      alerted.current.add(n.id);
      try {
        new Notification(n.title, { body: n.body, tag: n.id });
      } catch (err) {
        console.warn('Could not show a desktop alert', err);
      }
    }
  }, [unread, enabled]);
}
