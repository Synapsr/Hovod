import { useCallback, useRef, useState } from 'react';
import { formatTime } from '../lib/helpers.js';
import type { UserIdentity } from './IdentityModal.js';

interface CommentFormProps {
  onSubmit: (body: string, timestampSec?: number) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  dark: boolean;
  accentColor: string;
  isSubmitting: boolean;
  identity: UserIdentity | null;
  onRequestIdentity: () => void;
  onClearIdentity: () => void;
  labels: {
    addComment: string;
    send: string;
    commentingAt: string;
  };
}

export function CommentForm({ onSubmit, videoRef, dark, accentColor, isSubmitting, identity, onRequestIdentity, onClearIdentity, labels }: CommentFormProps) {
  const [body, setBody] = useState('');
  const [timestampMode, setTimestampMode] = useState(false);
  const [capturedTime, setCapturedTime] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const toggleTimestamp = useCallback(() => {
    if (!timestampMode && videoRef.current) {
      setCapturedTime(Math.floor(videoRef.current.currentTime));
    }
    setTimestampMode((v) => !v);
  }, [timestampMode, videoRef]);

  const handleSubmit = useCallback(() => {
    if (!body.trim()) return;
    if (!identity) {
      onRequestIdentity();
      return;
    }
    onSubmit(body.trim(), timestampMode ? capturedTime : undefined);
    setBody('');
    setTimestampMode(false);
  }, [body, identity, timestampMode, capturedTime, onSubmit, onRequestIdentity]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const handleFocus = useCallback(() => {
    if (!identity) {
      textareaRef.current?.blur();
      onRequestIdentity();
    }
  }, [identity, onRequestIdentity]);

  return (
    <div className={`rounded-2xl overflow-hidden transition-all ${
      dark
        ? 'bg-zinc-900/60 border border-zinc-800/60'
        : 'bg-zinc-50/80 border border-zinc-200/60'
    }`}>
      {/* Input area */}
      <div className="flex items-start gap-3 p-3">
        {/* Avatar */}
        {identity ? (
          <div
            className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-[11px] font-semibold text-white mt-0.5"
            style={{ backgroundColor: accentColor + 'cc' }}
          >
            {identity.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
          </div>
        ) : (
          <div className={`w-8 h-8 rounded-full shrink-0 flex items-center justify-center mt-0.5 ${dark ? 'bg-zinc-800' : 'bg-zinc-200/80'}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={dark ? 'text-zinc-600' : 'text-zinc-400'}>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" strokeLinecap="round" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          placeholder={labels.addComment}
          rows={2}
          maxLength={2000}
          disabled={isSubmitting}
          className={`flex-1 min-h-[40px] pt-1.5 text-sm resize-none outline-none bg-transparent ${
            dark
              ? 'text-zinc-100 placeholder-zinc-600'
              : 'text-zinc-800 placeholder-zinc-400'
          }`}
        />
      </div>

      {/* Bottom bar */}
      <div className={`flex items-center justify-between gap-2 px-3 pb-2.5 pt-0`}>
        <div className="flex items-center gap-1.5">
          {/* Timestamp toggle */}
          <button
            type="button"
            onClick={toggleTimestamp}
            className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-medium transition-all ${
              timestampMode
                ? 'text-white'
                : dark
                  ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                  : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200/60'
            }`}
            style={timestampMode ? { backgroundColor: accentColor } : undefined}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            {timestampMode ? `${labels.commentingAt} ${formatTime(capturedTime)}` : formatTime(videoRef.current?.currentTime ?? 0)}
          </button>

          {/* Identity badge */}
          {identity && (
            <button
              type="button"
              onClick={onClearIdentity}
              className={`inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] transition-colors ${
                dark ? 'text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200/60'
              }`}
            >
              {identity.name}
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-50">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Send */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || !body.trim()}
          className="inline-flex items-center gap-1.5 h-8 px-4 rounded-xl text-xs font-semibold text-white transition-all disabled:opacity-30 hover:brightness-110 active:scale-95"
          style={{ backgroundColor: accentColor }}
        >
          {isSubmitting ? (
            <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          ) : (
            <>
              {labels.send}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
