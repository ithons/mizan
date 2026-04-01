import React, { useEffect } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import { useAppStore } from '../store';
import type { Toast as ToastType } from '../store';

interface ToastItemProps {
  toast: ToastType;
  onRemove: (id: string) => void;
}

function ToastItem({ toast, onRemove }: ToastItemProps) {
  useEffect(() => {
    const timer = setTimeout(() => onRemove(toast.id), 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onRemove]);

  const icons = {
    success: <CheckCircle size={16} className="text-[#4ecba3] flex-shrink-0" />,
    error: <XCircle size={16} className="text-[#e07070] flex-shrink-0" />,
    info: <Info size={16} className="text-[#5b8dee] flex-shrink-0" />,
  };

  const borderColors = {
    success: 'border-l-[#4ecba3]',
    error: 'border-l-[#e07070]',
    info: 'border-l-[#5b8dee]',
  };

  return (
    <div
      className={`flex items-start gap-3 bg-surface border border-border border-l-2 ${borderColors[toast.type]} rounded px-4 py-3 shadow-lg min-w-[280px] max-w-[380px]`}
      style={{ animation: 'slideInRight 0.2s ease-out' }}
    >
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
      {icons[toast.type]}
      <p className="text-sm text-text flex-1">{toast.message}</p>
      <button
        onClick={() => onRemove(toast.id)}
        className="text-muted hover:text-text transition-colors flex-shrink-0 mt-0.5"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useAppStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>
  );
}
