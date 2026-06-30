import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Sidebar } from './Sidebar';

const STORAGE_KEY = 'mizan:sidebar';

function loadPrefs(): { collapsed: boolean; size: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.warn('Failed to load sidebar preferences', err);
  }
  return { collapsed: false, size: '16' };
}

function savePrefs(prefs: { collapsed: boolean; size: string }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn('Failed to save sidebar preferences', err);
  }
}

export function Layout() {
  const prefs = loadPrefs();
  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const [collapsed, setCollapsed] = useState(prefs.collapsed);
  const lastSizeRef = useRef(prefs.size);

  // Collapse panel after mount if pref says so
  useEffect(() => {
    if (prefs.collapsed) {
      sidebarRef.current?.collapse();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onResize = useCallback((panelSize: PanelSize) => {
    const isNowCollapsed = panelSize.asPercentage === 0;
    setCollapsed(isNowCollapsed);
    if (!isNowCollapsed) {
      const pct = String(Math.round(panelSize.asPercentage));
      lastSizeRef.current = pct;
      savePrefs({ collapsed: false, size: pct });
    } else {
      savePrefs({ collapsed: true, size: lastSizeRef.current });
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    if (sidebarRef.current?.isCollapsed()) {
      sidebarRef.current.expand();
    } else {
      sidebarRef.current?.collapse();
    }
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Group orientation="horizontal" style={{ width: '100%', height: '100%' }}>
        <Panel
          panelRef={sidebarRef}
          defaultSize={prefs.collapsed ? '0' : lastSizeRef.current}
          minSize="10"
          maxSize="30"
          collapsible
          onResize={onResize}
          style={{ overflow: 'hidden' }}
        >
          <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
        </Panel>

        <Separator
          className="group cursor-col-resize"
          style={{ width: 5, flexShrink: 0, background: 'var(--color-border)', transition: 'background 0.15s', position: 'relative', overflow: 'visible', zIndex: 10 }}
        >
          <button
            onClick={toggleSidebar}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-8 flex items-center justify-center rounded bg-surface shadow-sm border border-border text-muted opacity-0 group-hover:opacity-100 transition-opacity hover:text-text hover:border-green-50 z-10 shadow-sm"
            title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
          </button>
        </Separator>

        <Panel minSize="50" style={{ overflow: 'hidden' }}>
          <div className="relative h-full flex flex-col overflow-hidden">
            {collapsed && (
              <button
                onClick={toggleSidebar}
                className="absolute top-3 left-3 z-20 w-7 h-7 flex items-center justify-center rounded bg-surface shadow-sm border border-border text-muted hover:text-text hover:border-green-50 transition-colors shadow-sm"
                title="Show sidebar"
              >
                <PanelLeftOpen size={14} />
              </button>
            )}
            <main className="flex-1 overflow-y-auto h-full">
              <Outlet />
            </main>
          </div>
        </Panel>
      </Group>
    </div>
  );
}
