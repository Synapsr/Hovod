import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetDetail } from '../lib/types.js';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n/index.js';

const MAX_SIZE = 10_485_760; // 10 MB — matches the API bodyLimit
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const ACCEPT_ATTR = ACCEPTED.join(',');

interface ThumbnailModalProps {
  open: boolean;
  onClose: () => void;
  asset: AssetDetail;
  onSaved: () => void;
}

export function ThumbnailModal({ open, onClose, asset, onSaved }: ThumbnailModalProps) {
  const { t } = useT();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState<'upload' | 'reset' | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Revoke the object URL when the local preview changes or the modal unmounts
  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  // Reset transient state whenever the modal is (re)opened
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setError('');
    setBusy(null);
    setDragOver(false);
  }, [open]);

  const selectFile = useCallback((f: File) => {
    if (!ACCEPTED.includes(f.type)) { setError(t.thumbnailModal.errorType); return; }
    if (f.size > MAX_SIZE) { setError(t.thumbnailModal.errorSize); return; }
    setError('');
    setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f); });
    setFile(f);
  }, [t]);

  const handleUpload = useCallback(async () => {
    if (!file || busy) return;
    setBusy('upload');
    setError('');
    try {
      await api(`/v1/assets/${asset.id}/thumbnail`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
        raw: true,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.thumbnailModal.errorUpload);
      setBusy(null);
    }
  }, [file, busy, asset.id, onSaved, onClose, t]);

  const handleReset = useCallback(async () => {
    if (busy) return;
    setBusy('reset');
    setError('');
    try {
      await api(`/v1/assets/${asset.id}/thumbnail`, { method: 'DELETE' });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.thumbnailModal.errorUpload);
      setBusy(null);
    }
  }, [busy, asset.id, onSaved, onClose, t]);

  if (!open) return null;

  const displayUrl = previewUrl ?? asset.thumbnailUrl;
  const badge = previewUrl
    ? { label: t.thumbnailModal.newBadge, cls: 'bg-emerald-500/15 text-emerald-400' }
    : asset.hasCustomThumbnail
      ? { label: t.thumbnailModal.custom, cls: 'bg-accent-500/15 text-accent-400' }
      : asset.thumbnailUrl
        ? { label: t.thumbnailModal.auto, cls: 'bg-zinc-700/60 text-zinc-300' }
        : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { if (!busy) onClose(); }} />
      <div
        className="relative z-10 w-full max-w-md mx-4 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl animate-slideUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-0">
          <h2 className="text-base font-semibold text-zinc-100">{t.thumbnailModal.title}</h2>
          <button
            onClick={() => { if (!busy) onClose(); }}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-xs text-zinc-500 -mt-1">{t.thumbnailModal.description}</p>

          {/* Current / preview */}
          <div className="relative w-full rounded-xl overflow-hidden bg-zinc-950 border border-zinc-800" style={{ aspectRatio: '16/9' }}>
            {displayUrl ? (
              <img src={displayUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-600">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                </svg>
                <span className="text-xs">{t.thumbnailModal.none}</span>
              </div>
            )}
            {badge && (
              <span className={`absolute top-2 left-2 text-[10px] font-semibold px-2 py-0.5 rounded-full backdrop-blur-sm ${badge.cls}`}>
                {badge.label}
              </span>
            )}
          </div>

          {/* Drop zone */}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) selectFile(f);
            }}
            className={`w-full flex flex-col items-center justify-center gap-1.5 px-4 py-5 rounded-xl border border-dashed transition-colors cursor-pointer ${
              dragOver
                ? 'border-accent-500 bg-accent-500/5'
                : 'border-zinc-700 hover:border-zinc-600 bg-zinc-800/30 hover:bg-zinc-800/50'
            }`}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span className="text-xs font-medium text-zinc-300">
              {file ? file.name : t.thumbnailModal.dropHint}
            </span>
            <span className="text-[10px] text-zinc-600">{t.thumbnailModal.formats}</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) selectFile(f);
              e.target.value = '';
            }}
          />

          {error && <p className="text-xs text-red-400">{error}</p>}

          {/* Actions */}
          <div className="flex items-center justify-between gap-3 pt-1">
            {asset.hasCustomThumbnail ? (
              <button
                onClick={handleReset}
                disabled={!!busy}
                className="h-9 px-3 text-sm font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy === 'reset' ? t.thumbnailModal.resetting : t.thumbnailModal.resetToAuto}
              </button>
            ) : <span />}
            <button
              onClick={handleUpload}
              disabled={!file || !!busy}
              className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === 'upload' ? t.thumbnailModal.uploading : t.thumbnailModal.setThumbnail}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
