import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import type { AppNotification } from '@shared/types';
import { notificationsApi } from '../lib/api';
import { formatCompactRelative } from '../lib/formatters';
import { useDesktopAlerts, useDesktopAlertsPreference } from '../lib/desktopAlerts';
import { useAppStore } from '../store';
import { Modal } from './Modal';
import { TextButton } from './balance';

const SEVERITY_WORD: Record<AppNotification['severity'], string | null> = {
  info: null,
  warning: 'Warning',
  critical: 'Critical',
};

function useNotificationMutations() {
  const queryClient = useQueryClient();
  const { addToast } = useAppStore();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const onError = (err: Error) => addToast({ type: 'error', message: err.message });
  return {
    markRead: useMutation({ mutationFn: notificationsApi.markRead, onSuccess: refresh, onError }),
    dismiss: useMutation({ mutationFn: notificationsApi.dismiss, onSuccess: refresh, onError }),
    evaluate: useMutation({
      mutationFn: notificationsApi.evaluate,
      onSuccess: (summary) => {
        refresh();
        if (summary.errors.length > 0) {
          addToast({ type: 'error', message: `${summary.errors.length} rule${summary.errors.length === 1 ? '' : 's'} could not run: ${summary.errors[0].message}` });
        } else {
          addToast({ type: 'info', message: summary.created.length === 0 ? 'Nothing new' : `${summary.created.length} new` });
        }
      },
      onError,
    }),
  };
}

function InboxRow({ notification, onOpen }: { notification: AppNotification; onOpen: (n: AppNotification) => void }) {
  const { markRead, dismiss } = useNotificationMutations();
  const unread = notification.read_at === null;
  const severity = SEVERITY_WORD[notification.severity];
  return (
    <li className="border-b border-line py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className={`text-body ${unread ? 'font-medium text-ink' : 'text-muted'}`}>
          {severity && <span className="mr-2 text-note uppercase tracking-wide text-ink">{severity}</span>}
          {notification.title}
        </div>
        <div className="flex-shrink-0 text-note tabular-nums text-muted-2">{formatCompactRelative(notification.created_at)}</div>
      </div>
      <p className="mt-0.5 text-note leading-relaxed text-muted">{notification.body}</p>
      <div className="mt-1.5 flex gap-4">
        {notification.route && (
          <TextButton variant="primary" className="text-note" onClick={() => onOpen(notification)}>Open</TextButton>
        )}
        {unread && (
          <TextButton className="text-note" onClick={() => markRead.mutate([notification.id])}>Mark read</TextButton>
        )}
        <TextButton className="text-note" onClick={() => dismiss.mutate(notification.id)}>Dismiss</TextButton>
      </div>
    </li>
  );
}

function Inbox({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { markRead, evaluate } = useNotificationMutations();
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notificationsApi.list({ limit: 100 }),
  });
  const open = (n: AppNotification) => {
    if (n.read_at === null) markRead.mutate([n.id]);
    onClose();
    if (n.route) navigate(n.route);
  };
  const hasUnread = (data ?? []).some((n) => n.read_at === null);

  return (
    <div>
      <div className="mb-2 flex gap-4">
        <TextButton className="text-note" onClick={() => evaluate.mutate()} disabled={evaluate.isPending}>
          {evaluate.isPending ? 'Checking…' : 'Check now'}
        </TextButton>
        {hasUnread && (
          <TextButton className="text-note" onClick={() => markRead.mutate('all')}>Mark all read</TextButton>
        )}
        <Link to="/settings?section=notifications" onClick={onClose} className="ml-auto text-note text-muted hover:text-ink">
          Rules
        </Link>
      </div>
      {isPending && <p className="py-6 text-note text-muted">Reading notifications…</p>}
      {isError && <p className="py-6 text-note text-ink">Could not load notifications: {error.message}</p>}
      {data && data.length === 0 && (
        <p className="py-6 text-note leading-relaxed text-muted">
          Nothing here. The rules turned on in Settings write here when one of them fires, after each sync.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="max-h-[60vh] overflow-y-auto">
          {data.map((n) => <InboxRow key={n.id} notification={n} onOpen={open} />)}
        </ul>
      )}
    </div>
  );
}

/** The rail's entry to the inbox, labelled at full width and an icon with a count when collapsed. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { state: alerts } = useDesktopAlertsPreference();
  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: notificationsApi.unreadCount,
    staleTime: 60_000,
  });
  const { data: unreadList } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => notificationsApi.list({ unreadOnly: true, limit: 20 }),
    enabled: alerts === 'on',
  });
  useDesktopAlerts(unreadList, alerts === 'on');

  const count = unread?.count ?? 0;
  const label = count === 0 ? 'Notifications, none unread' : `Notifications, ${count} unread`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        className="group grid w-full grid-cols-[18px_1fr] items-center gap-x-2 py-[7px] pl-3 pr-[22px] max-[999px]:flex max-[999px]:justify-center max-[999px]:px-0"
      >
        <span aria-hidden className="h-px w-full max-[999px]:hidden" />
        <span aria-hidden className="relative hidden rounded-md p-1.5 text-muted group-hover:text-ink max-[999px]:block">
          <Bell size={18} strokeWidth={1.6} />
          {count > 0 && (
            <span className="absolute -right-1 -top-1 min-w-[16px] rounded-full bg-ink px-1 text-center text-micro leading-4 text-paper tabular-nums">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </span>
        <span aria-hidden className="text-right text-sub text-muted transition-colors group-hover:text-ink max-[999px]:hidden">
          Inbox
          {count > 0 && <span className="ml-1.5 font-medium text-ink tabular-nums">{count}</span>}
        </span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Notifications" maxWidth="560px">
        <Inbox onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}
