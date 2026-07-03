import React, { useState, useRef, useEffect } from 'react';
import { Check, X } from 'lucide-react';

interface InlineEditProps {
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}

export function InlineEdit({ value, onSave, placeholder, className, inputClassName }: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, value]);

  const save = () => {
    if (draft.trim() && draft.trim() !== value) {
      onSave(draft.trim());
    }
    setEditing(false);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') cancel();
          }}
          onBlur={save}
          placeholder={placeholder}
          className={`bg-background border border-positive-5 rounded px-2 py-0.5 text-xs text-text focus:outline-none focus:ring-1 focus:ring-positive-5 ${inputClassName ?? ''}`}
        />
        <button
          onMouseDown={(e) => { e.preventDefault(); save(); }}
          className="text-positive hover:opacity-80"
          tabIndex={-1}
        >
          <Check size={12} />
        </button>
        <button
          onMouseDown={(e) => { e.preventDefault(); cancel(); }}
          className="text-muted hover:text-text"
          tabIndex={-1}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className={`text-left hover:text-positive transition-colors cursor-text ${className ?? ''}`}
      title="Click to edit"
    >
      {value || <span className="text-muted">{placeholder}</span>}
    </button>
  );
}
