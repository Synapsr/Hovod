import { useCallback, useState } from 'react';
import type { AssetDetail, AssetPublicSettings } from '../lib/types.js';
import { api } from '../lib/api.js';
import { RichTextEditor } from './RichTextEditor.js';
import { useT } from '../lib/i18n/index.js';

const DEFAULT_SETTINGS: AssetPublicSettings = {
  allowDownload: false,
  showTranscript: true,
  showChapters: true,
  showComments: true,
};

interface VideoSettingsModalProps {
  open: boolean;
  onClose: () => void;
  asset: AssetDetail;
  onSaved: () => void;
}

export function VideoSettingsModal({ open, onClose, asset, onSaved }: VideoSettingsModalProps) {
  const { t } = useT();
  const ps = asset.publicSettings ?? DEFAULT_SETTINGS;

  const [title, setTitle] = useState(asset.title);
  const [description, setDescription] = useState(asset.description ?? '');
  const [allowDownload, setAllowDownload] = useState(ps.allowDownload);
  const [showTranscript, setShowTranscript] = useState(ps.showTranscript);
  const [showChapters, setShowChapters] = useState(ps.showChapters);
  const [showComments, setShowComments] = useState(ps.showComments ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const hasChanges =
    title !== asset.title ||
    description !== (asset.description ?? '') ||
    allowDownload !== ps.allowDownload ||
    showTranscript !== ps.showTranscript ||
    showChapters !== ps.showChapters ||
    showComments !== (ps.showComments ?? true);

  const handleSave = useCallback(async () => {
    if (!hasChanges || saving) return;
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {};
      if (title !== asset.title) body.title = title;
      if (description !== (asset.description ?? '')) body.description = description;
      if (
        allowDownload !== ps.allowDownload ||
        showTranscript !== ps.showTranscript ||
        showChapters !== ps.showChapters ||
        showComments !== (ps.showComments ?? true)
      ) {
        body.publicSettings = { allowDownload, showTranscript, showChapters, showComments };
      }
      await api(`/v1/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [hasChanges, saving, title, description, asset, allowDownload, showTranscript, showChapters, showComments, ps, onSaved, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative z-10 w-full max-w-md mx-4 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl animate-slideUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-0">
          <h2 className="text-base font-semibold text-zinc-100">{t.videoSettings.title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-5">
          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-2">{t.videoSettings.titleLabel}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full h-9 px-3 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-500 outline-none focus:border-zinc-500 transition-colors"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-2">{t.videoSettings.description}</label>
            <RichTextEditor
              value={description}
              onChange={setDescription}
              placeholder={t.videoSettings.descriptionPlaceholder}
              maxLength={2000}
            />
          </div>

          {/* Public page settings */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span className="text-xs font-medium text-zinc-400">{t.videoSettings.publicPage}</span>
            </div>
            <div className="space-y-1">
              <SettingsToggle
                label={t.videoSettings.allowDownload}
                description={t.videoSettings.allowDownloadDesc}
                checked={allowDownload}
                onChange={setAllowDownload}
              />
              <SettingsToggle
                label={t.videoSettings.showTranscript}
                description={t.videoSettings.showTranscriptDesc}
                checked={showTranscript}
                onChange={setShowTranscript}
              />
              <SettingsToggle
                label={t.videoSettings.showChapters}
                description={t.videoSettings.showChaptersDesc}
                checked={showChapters}
                onChange={setShowChapters}
              />
              <SettingsToggle
                label={t.videoSettings.showComments}
                description={t.videoSettings.showCommentsDesc}
                checked={showComments}
                onChange={setShowComments}
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}

          {/* Save */}
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={!hasChanges || saving}
              className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? t.common.saving : t.common.saveChanges}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Toggle sub-component ─────────────────────────────────── */

function SettingsToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-4 p-3 rounded-lg hover:bg-zinc-800/40 transition-colors text-left"
    >
      <div className="min-w-0">
        <p className="text-sm text-zinc-200">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
      </div>
      <div
        role="switch"
        aria-checked={checked}
        className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
          checked ? 'bg-accent-600' : 'bg-zinc-700'
        }`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : ''
        }`} />
      </div>
    </button>
  );
}
