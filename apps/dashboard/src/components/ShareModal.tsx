import { useCallback, useMemo, useState } from 'react';
import type { AssetDetail } from '../lib/types.js';
import { useSettings } from '../lib/settings-context.js';
import { CopyField } from './CopyField.js';
import { useT } from '../lib/i18n/index.js';

const PRESET_COLORS = [
  { label: 'Indigo', value: '#6366f1' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Cyan', value: '#06b6d4' },
  { label: 'Emerald', value: '#10b981' },
  { label: 'Amber', value: '#f59e0b' },
  { label: 'Rose', value: '#f43f5e' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'White', value: '#ffffff' },
];

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  asset: AssetDetail;
  manifest: string;
}

export function ShareModal({ open, onClose, asset, manifest }: ShareModalProps) {
  const { t } = useT();
  const { settings } = useSettings();
  const [copiedField, setCopiedField] = useState('');
  const [devOpen, setDevOpen] = useState(false);

  // Embed customization — default to org's accent color
  const [color, setColor] = useState(settings.primaryColor);
  const [showTitle, setShowTitle] = useState(false);
  const [customTitle, setCustomTitle] = useState('');

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(''), 2000);
  }, []);

  const effectiveTitle = showTitle ? (customTitle || asset.title || '') : '';

  const previewQs = useMemo(() => {
    const params = new URLSearchParams();
    if (color !== settings.primaryColor) params.set('color', color);
    if (effectiveTitle) params.set('title', effectiveTitle);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [color, effectiveTitle, settings.primaryColor]);

  const embedUrl = useMemo(() => {
    if (!asset.playbackId) return '';
    return `${window.location.origin}/embed/${asset.playbackId}${previewQs}`;
  }, [asset.playbackId, previewQs]);

  const iframeCode = useMemo(() => {
    if (!embedUrl) return '';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const titleAttr = esc(effectiveTitle || 'Video player');
    return `<iframe src="${esc(embedUrl)}" title="${titleAttr}" style="aspect-ratio:16/9;width:100%;border:0" allow="autoplay;fullscreen" sandbox="allow-scripts allow-same-origin" allowfullscreen></iframe>`;
  }, [embedUrl, effectiveTitle]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative z-10 w-full max-w-lg mx-4 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl animate-slideUp max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-0">
          <h2 className="text-base font-semibold text-zinc-100">{t.share.embedVideo}</h2>
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
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Live preview */}
          <div className="relative w-full bg-black rounded-xl overflow-hidden" style={{ aspectRatio: '16/9' }}>
            <iframe
              key={previewQs}
              src={`/embed/${asset.playbackId}${previewQs}`}
              title={t.share.embedPreview}
              className="absolute inset-0 w-full h-full border-0"
              allow="autoplay; fullscreen"
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
            />
          </div>

          {/* Accent color */}
          <div>
            <label className="text-xs text-zinc-500 mb-2 block">{t.share.accentColor}</label>
            <div className="flex items-center gap-1.5 flex-wrap">
              {PRESET_COLORS.map((preset) => (
                <button
                  key={preset.value}
                  onClick={() => setColor(preset.value)}
                  className={`w-7 h-7 rounded-full border-2 transition-all hover:scale-110 ${
                    color === preset.value ? 'border-white scale-110' : 'border-transparent hover:border-zinc-500'
                  }`}
                  style={{ backgroundColor: preset.value }}
                  aria-label={preset.label}
                  title={preset.label}
                />
              ))}
              <label className="relative w-7 h-7 cursor-pointer">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="sr-only"
                  aria-label="Custom color"
                />
                <span
                  className="block w-7 h-7 rounded-full border-2 border-dashed border-zinc-600 hover:border-zinc-400 transition-colors"
                  style={{ background: 'conic-gradient(from 0deg, #f43f5e, #f59e0b, #10b981, #3b82f6, #a855f7, #f43f5e)' }}
                />
              </label>
            </div>
          </div>

          {/* Title overlay */}
          <div>
            <div className="flex items-center gap-3 mb-2">
              <label className="text-xs text-zinc-500">{t.share.titleOverlay}</label>
              <button
                onClick={() => setShowTitle(!showTitle)}
                className="relative inline-flex items-center w-9 h-5 rounded-full transition-colors shrink-0"
                style={{ backgroundColor: showTitle ? color : '#3f3f46' }}
                role="switch"
                aria-checked={showTitle}
                aria-label={t.share.showTitleOverlay}
              >
                <span
                  className="block w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform duration-200"
                  style={{ transform: showTitle ? 'translateX(18px)' : 'translateX(3px)' }}
                />
              </button>
            </div>
            {showTitle && (
              <input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder={asset.title}
                className="w-full h-9 px-3 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-500 outline-none focus:border-zinc-500 transition-colors"
                aria-label="Custom title"
              />
            )}
          </div>

          {/* Embed code */}
          <CopyField
            label={t.share.embedCode}
            value={iframeCode}
            copied={copiedField === 'iframe'}
            onCopy={() => handleCopy(iframeCode, 'iframe')}
          />

          {/* Developer section — collapsible */}
          <div>
            <button
              onClick={() => setDevOpen(!devOpen)}
              className="flex items-center gap-2 text-xs font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`transition-transform ${devOpen ? 'rotate-90' : ''}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              {t.share.developer}
            </button>
            {devOpen && (
              <div className="mt-3 space-y-4 pl-5 border-l border-zinc-800">
                <CopyField
                  label={t.share.directEmbedUrl}
                  value={embedUrl}
                  copied={copiedField === 'embed'}
                  onCopy={() => handleCopy(embedUrl, 'embed')}
                />
                {manifest && (
                  <CopyField
                    label={t.share.hlsManifest}
                    value={manifest}
                    copied={copiedField === 'hls'}
                    onCopy={() => handleCopy(manifest, 'hls')}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
