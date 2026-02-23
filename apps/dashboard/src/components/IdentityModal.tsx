import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n/index.js';

export interface UserIdentity {
  name: string;
  email: string;
}

const LS_NAME_KEY = 'hovod_comment_name';
const LS_EMAIL_KEY = 'hovod_comment_email';

export function getSavedIdentity(): UserIdentity | null {
  const name = localStorage.getItem(LS_NAME_KEY);
  const email = localStorage.getItem(LS_EMAIL_KEY);
  if (name && email) return { name, email };
  return null;
}

export function saveIdentity(identity: UserIdentity) {
  localStorage.setItem(LS_NAME_KEY, identity.name);
  localStorage.setItem(LS_EMAIL_KEY, identity.email);
}

export function clearIdentity() {
  localStorage.removeItem(LS_NAME_KEY);
  localStorage.removeItem(LS_EMAIL_KEY);
}

interface IdentityModalProps {
  open: boolean;
  onConfirm: (identity: UserIdentity) => void;
  onClose: () => void;
  dark: boolean;
  accentColor: string;
  labels: { name: string; email: string };
}

export function IdentityModal({ open, onConfirm, onClose, dark, accentColor, labels }: IdentityModalProps) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setEmail('');
      setEmailError(false);
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = useCallback(() => {
    const trimName = name.trim();
    const trimEmail = email.trim();
    if (!trimName || !trimEmail) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimEmail)) {
      setEmailError(true);
      return;
    }
    const identity = { name: trimName, email: trimEmail };
    saveIdentity(identity);
    onConfirm(identity);
  }, [name, email, onConfirm]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') onClose();
  }, [handleSubmit, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className={`relative w-full max-w-sm rounded-2xl p-6 shadow-2xl animate-[fadeSlideIn_0.2s_ease-out] ${
          dark ? 'bg-zinc-900 border border-zinc-800' : 'bg-white border border-zinc-200'
        }`}
        onKeyDown={handleKeyDown}
      >
        <h3 className={`text-base font-semibold mb-1 ${dark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          {t.identity.beforeContinue}
        </h3>
        <p className={`text-xs mb-5 ${dark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          {t.identity.emailHint}
        </p>

        <div className="space-y-3">
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={labels.name}
            maxLength={100}
            className={`w-full h-11 px-4 text-sm rounded-xl outline-none transition-all border ${
              dark
                ? 'bg-zinc-800/80 border-zinc-700/60 text-zinc-100 placeholder-zinc-500 focus:border-zinc-500'
                : 'bg-zinc-50 border-zinc-200 text-zinc-900 placeholder-zinc-400 focus:border-zinc-400'
            }`}
          />
          <input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setEmailError(false); }}
            placeholder={labels.email}
            maxLength={255}
            className={`w-full h-11 px-4 text-sm rounded-xl outline-none transition-all border ${
              emailError
                ? 'border-red-500/60 focus:border-red-500'
                : dark
                  ? 'bg-zinc-800/80 border-zinc-700/60 text-zinc-100 placeholder-zinc-500 focus:border-zinc-500'
                  : 'bg-zinc-50 border-zinc-200 text-zinc-900 placeholder-zinc-400 focus:border-zinc-400'
            }`}
          />
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className={`flex-1 h-10 rounded-xl text-sm font-medium transition-colors ${
              dark ? 'text-zinc-400 hover:bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
          >
            {t.common.cancel}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || !email.trim()}
            className="flex-1 h-10 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:brightness-110 active:scale-[0.98]"
            style={{ backgroundColor: accentColor }}
          >
            {t.identity.continue}
          </button>
        </div>
      </div>
    </div>
  );
}
