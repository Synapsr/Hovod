import { useCallback, useEffect, useRef, useState } from 'react';

interface InlineEditProps {
  value: string;
  onSave: (newValue: string) => Promise<void>;
  dark?: boolean;
  className?: string;
  as?: 'h1' | 'span';
}

export function InlineEdit({ value, onSave, dark = false, className = '', as: Tag = 'span' }: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const save = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value) {
      setDraft(value);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch {
      setDraft(value);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [draft, value, onSave]);

  const cancel = useCallback(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }, [save, cancel]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        disabled={saving}
        className={`${className} w-full bg-transparent outline-none rounded-md px-1.5 -mx-1.5 transition-all ring-2 ${
          dark
            ? 'ring-accent-500/40 text-zinc-100'
            : 'ring-accent-400/50 text-zinc-900'
        } ${saving ? 'opacity-50' : ''}`}
      />
    );
  }

  return (
    <Tag
      onClick={() => setEditing(true)}
      className={`${className} group/edit cursor-pointer rounded-md px-1.5 -mx-1.5 transition-all ${
        dark
          ? 'hover:bg-zinc-800/60 text-zinc-100'
          : 'hover:bg-zinc-100 text-zinc-900'
      }`}
    >
      {value}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`inline-block ml-2 opacity-0 group-hover/edit:opacity-60 transition-opacity align-middle ${
          dark ? 'text-zinc-500' : 'text-zinc-400'
        }`}
      >
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        <path d="m15 5 4 4" />
      </svg>
    </Tag>
  );
}
