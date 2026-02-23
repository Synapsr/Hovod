import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import type { AssetDetail } from '../lib/types.js';
import type { Translations } from '../lib/i18n/types.js';
import { api } from '../lib/api.js';
import { formatDuration, formatFileSize, estimateRenditionSize } from '../lib/helpers.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { AssetAnalytics } from '../components/AssetAnalytics.js';
import { ShareModal } from '../components/ShareModal.js';
import { VideoSettingsModal } from '../components/VideoSettingsModal.js';
import { useT } from '../lib/i18n/index.js';

/** Statuses that are still changing and need polling */
const POLL_STATUSES = new Set(['created', 'uploaded', 'queued', 'processing']);
const POLL_INTERVAL = 4000;

/** Build the processing steps array using translated labels */
function getAllProcessingSteps(t: Translations): { key: string; label: string }[] {
  return [
    { key: 'downloading', label: t.videoDetail.downloading },
    { key: 'probing', label: t.videoDetail.analyzing },
    { key: 'transcoding_360p', label: '360p' },
    { key: 'transcoding_480p', label: '480p' },
    { key: 'transcoding_720p', label: '720p' },
    { key: 'transcoding_1080p', label: '1080p' },
    { key: 'transcoding_1440p', label: '1440p' },
    { key: 'transcoding_2160p', label: '2160p' },
    { key: 'transcoding_4320p', label: '4320p' },
    { key: 'thumbnails', label: t.videoDetail.thumbnails },
    { key: 'uploading', label: t.common.uploading.replace('...', '') },
    { key: 'ai_processing', label: t.videoDetail.ai },
    { key: 'finalizing', label: t.videoDetail.finalizing },
  ];
}

/** Build source labels using translated strings */
function getSourceLabels(t: Translations): Record<string, string> {
  return {
    upload: t.videoDetail.directUpload,
    url: t.videoDetail.urlImport,
  };
}

/** Build AI row config using translated strings */
function getAiRowCfg(t: Translations): Record<string, { label: string; color: string }> {
  return {
    completed:  { label: t.videoDetail.ready,        color: 'text-zinc-300' },
    processing: { label: t.videoDetail.generating,   color: 'text-blue-400' },
    pending:    { label: t.videoDetail.queued,        color: 'text-zinc-500' },
    failed:     { label: t.videoDetail.failed,        color: 'text-red-400' },
    skipped:    { label: t.videoDetail.skipped,       color: 'text-zinc-600' },
  };
}

export function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useT();

  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [manifest, setManifest] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renditionsOpen, setRenditionsOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [devInfoOpen, setDevInfoOpen] = useState(false);
  const [metaKey, setMetaKey] = useState('');
  const [metaValue, setMetaValue] = useState('');
  const [metaSaving, setMetaSaving] = useState(false);
  const [dlOpen, setDlOpen] = useState(false);
  const [dlInfo, setDlInfo] = useState<{ downloadUrl: string; fileSizeBytes: number | null } | null>(null);
  const dlRef = useRef<HTMLDivElement>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAsset = useCallback(async (showLoading = false) => {
    if (!id) return;
    if (showLoading) setLoading(true);
    try {
      const [a] = await Promise.all([
        api<AssetDetail>(`/v1/assets/${id}`),
        api<{ manifestUrl: string }>(`/v1/assets/${id}/playback`)
          .then((d) => setManifest(d.manifestUrl))
          .catch(() => {}),
      ]);
      setAsset(a);
      setError('');
    } catch {
      if (showLoading) setError(t.videoDetail.assetNotFound);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [id, t]);

  // Initial fetch
  useEffect(() => {
    fetchAsset(true);
  }, [fetchAsset]);

  // Poll while asset is in a transitional state
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (asset && POLL_STATUSES.has(asset.status)) {
      pollRef.current = setInterval(() => fetchAsset(false), POLL_INTERVAL);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [asset?.status, fetchAsset]);

  // Close download dropdown on outside click
  useEffect(() => {
    if (!dlOpen) return;
    const handler = (e: MouseEvent) => {
      if (dlRef.current && !dlRef.current.contains(e.target as Node)) setDlOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dlOpen]);

  // Fetch original file info when dropdown opens
  useEffect(() => {
    if (!dlOpen || dlInfo || !id) return;
    api<{ downloadUrl: string; fileSizeBytes: number | null }>(`/v1/assets/${id}/download`)
      .then(setDlInfo)
      .catch(() => {});
  }, [dlOpen, dlInfo, id]);

  const saveMetadata = async (newMeta: Record<string, string>) => {
    if (!id) return;
    setMetaSaving(true);
    try {
      await api(`/v1/assets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ metadata: newMeta }),
      });
      setAsset((prev) => prev ? { ...prev, customMetadata: Object.keys(newMeta).length ? newMeta : null } : prev);
    } catch { /* ignore */ }
    setMetaSaving(false);
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await api(`/v1/assets/${id}`, { method: 'DELETE' });
      navigate('/videos');
    } catch {
      setDeleting(false);
    }
  };

  const isReady = asset?.status === 'ready' && asset.playbackId;
  const sourceLabels = getSourceLabels(t);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-32 bg-zinc-800 rounded animate-pulse" />
        <div className="aspect-video bg-zinc-900 rounded-xl animate-pulse" />
        <div className="grid grid-cols-2 gap-4">
          <div className="h-32 bg-zinc-900 rounded-xl animate-pulse" />
          <div className="h-32 bg-zinc-900 rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (error || !asset) {
    return (
      <div className="py-20 text-center">
        <p className="text-sm text-zinc-400">{error || t.videoDetail.assetNotFound}</p>
        <Link to="/videos" className="text-xs text-accent-400 hover:text-accent-500 mt-2 inline-block">
          {t.videoDetail.backToVideos}
        </Link>
      </div>
    );
  }

  return (
    <>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6">
        <Link to="/videos" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
          {t.nav.videos}
        </Link>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600">
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="text-xs text-zinc-300 truncate">{asset.title}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-lg font-semibold truncate">{asset.title}</h1>
          <StatusBadge status={asset.status} />
        </div>
        <div className="shrink-0 ml-3 flex items-center gap-2">
          {isReady && (
            <>
              {/* Split button: View page (primary) + Copy link */}
              <div className="flex items-center rounded-lg overflow-hidden">
                <a
                  href={`/watch/${asset.playbackId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-8 px-3 text-xs font-medium bg-accent-600 text-white hover:bg-accent-500 transition-colors flex items-center gap-1.5"
                >
                  {t.videoDetail.viewPage}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
                <div className="w-px h-8 bg-accent-700" />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/watch/${asset.playbackId}`);
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 2000);
                  }}
                  className={`h-8 px-2 transition-colors flex items-center cursor-pointer ${
                    linkCopied
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-accent-600 text-white/70 hover:bg-accent-500 hover:text-white'
                  }`}
                  title={linkCopied ? t.common.copied : t.videoDetail.copyLink}
                >
                  {linkCopied ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              </div>
              <button
                onClick={() => setEmbedOpen(true)}
                className="h-8 px-3 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
                {t.videoDetail.embed}
              </button>
              <div className="relative" ref={dlRef}>
                <button
                  onClick={() => setDlOpen(!dlOpen)}
                  className="h-8 px-3 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors flex items-center gap-1.5 cursor-pointer"
                  title={t.common.download}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${dlOpen ? 'rotate-180' : ''}`}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {dlOpen && (
                  <div className="absolute right-0 top-full mt-1.5 w-56 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-xl z-50 overflow-hidden">
                    {/* Original */}
                    <button
                      onClick={() => {
                        if (dlInfo?.downloadUrl) {
                          window.open(dlInfo.downloadUrl, '_blank');
                          setDlOpen(false);
                        }
                      }}
                      className="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-zinc-800 transition-colors text-left cursor-pointer"
                    >
                      <div>
                        <div className="text-xs font-medium text-zinc-200">{t.videoDetail.original}</div>
                        <div className="text-[10px] text-zinc-500">{t.videoDetail.sourceFile}</div>
                      </div>
                      <span className="text-[11px] text-zinc-400 tabular-nums">
                        {dlInfo ? (dlInfo.fileSizeBytes ? formatFileSize(dlInfo.fileSizeBytes) : '--') : '...'}
                      </span>
                    </button>
                    {/* Renditions */}
                    {asset.renditions.length > 0 && asset.durationSec && (
                      <>
                        <div className="h-px bg-zinc-800" />
                        {asset.renditions
                          .sort((a, b) => b.height - a.height)
                          .map((r) => {
                            const size = r.fileSizeBytes ?? (asset.durationSec ? estimateRenditionSize(r.bitrateKbps, asset.durationSec) : null);
                            return (
                              <button
                                key={r.id}
                                onClick={async () => {
                                  try {
                                    const data = await api<{ downloadUrl: string; fileSizeBytes: number | null }>(`/v1/assets/${id}/download?quality=${r.quality}`);
                                    window.open(data.downloadUrl, '_blank');
                                    setDlOpen(false);
                                  } catch {
                                    // Rendition MP4 not yet available (old assets)
                                  }
                                }}
                                className="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-zinc-800 transition-colors text-left cursor-pointer"
                              >
                                <div>
                                  <div className="text-xs font-medium text-zinc-300">{r.quality}</div>
                                  <div className="text-[10px] text-zinc-500">{r.width}x{r.height}</div>
                                </div>
                                <span className="text-[11px] text-zinc-500 tabular-nums">
                                  {size ? `${r.fileSizeBytes ? '' : '~'}${formatFileSize(size)}` : '--'}
                                </span>
                              </button>
                            );
                          })}
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="w-px h-5 bg-zinc-700/40 mx-1" />
              <button
                onClick={() => setSettingsOpen(true)}
                className="h-8 px-2.5 text-xs rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors flex items-center cursor-pointer"
                title={t.videoDetail.videoSettings}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </>
          )}
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="h-8 px-3 text-xs font-medium rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              {t.common.delete}
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="h-8 px-3 text-xs font-medium rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {deleting ? t.common.deleting : t.common.confirm}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="h-8 px-3 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
              >
                {t.common.cancel}
              </button>
            </div>
          )}
        </div>
      </div>

      {asset.errorMessage && asset.status !== 'error' && (
        <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {asset.errorMessage}
        </div>
      )}

      {/* Two-column layout on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Player or status hero */}
        <div className="lg:col-span-2">
          {isReady ? (
            <div className="relative w-full bg-black rounded-xl overflow-hidden group/player" style={{ aspectRatio: '16/9' }}>
              <iframe
                src={`/embed/${asset.playbackId}`}
                title="Video player"
                className="absolute inset-0 w-full h-full border-0"
                allow="autoplay; fullscreen"
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
              />
              <ThumbnailButton assetId={asset.id} onUpdated={fetchAsset} t={t} />
            </div>
          ) : (
            <StatusHero status={asset.status} errorMessage={asset.errorMessage} currentStep={asset.currentStep} t={t} />
          )}

          {/* AI Features — below video */}
          {asset.aiJob && asset.aiJob.status !== 'skipped' && (
            <div className="mt-4 flex items-center gap-5 px-1">
              <AiFeatureRow label={t.videos.subtitles} status={asset.aiJob.subtitlesStatus} t={t} />
              <AiFeatureRow label={t.videos.chapters} status={asset.aiJob.chaptersStatus} t={t} />
              {asset.aiJob.language && (
                <>
                  <div className="w-px h-4 bg-zinc-800" />
                  <span className="text-[11px] text-zinc-500">{t.languages[asset.aiJob.language as keyof typeof t.languages] ?? asset.aiJob.language}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right column: Metadata */}
        <div className="space-y-6">
          {/* About */}
          <div className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">{t.videoDetail.about}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-zinc-800/80 flex items-center justify-center shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500">
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-semibold text-zinc-200 tabular-nums">{asset.durationSec ? formatDuration(asset.durationSec) : '\u2014'}</div>
                  <div className="text-[10px] text-zinc-500">{t.videoDetail.duration}</div>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-zinc-800/80 flex items-center justify-center shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500">
                    <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-semibold text-zinc-200">{new Date(asset.createdAt).toLocaleDateString()}</div>
                  <div className="text-[10px] text-zinc-500">{t.videoDetail.created}</div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 mt-4">
              <div className="w-8 h-8 rounded-lg bg-zinc-800/80 flex items-center justify-center shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <div>
                <div className="text-sm text-zinc-300">{sourceLabels[asset.sourceType] ?? asset.sourceType}</div>
                <div className="text-[10px] text-zinc-500">{t.videoDetail.source}</div>
              </div>
            </div>
            {/* Developer info (collapsible) */}
            <div className="mt-4 pt-3 border-t border-zinc-800/40">
              <button
                onClick={() => setDevInfoOpen(!devInfoOpen)}
                className="flex items-center gap-2 text-xs font-medium text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              >
                <svg
                  width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={`transition-transform ${devInfoOpen ? 'rotate-90' : ''}`}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                {t.videoDetail.developerInfo}
              </button>
              {devInfoOpen && (
                <div className="mt-3 space-y-2.5 pl-5 border-l border-zinc-800">
                  <DevIdRow label={t.videoDetail.assetId} value={asset.id} t={t} />
                  <DevIdRow label={t.videoDetail.playbackId} value={asset.playbackId} t={t} />

                  {/* Metadata key-value editor */}
                  <div className="pt-2">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5">{t.videoDetail.metadata}</div>
                    {(() => {
                      const entries = Object.entries(asset.customMetadata ?? {});
                      return entries.length === 0 && !metaSaving ? (
                        <div className="text-[11px] text-zinc-600 italic">{t.videoDetail.metadataEmpty}</div>
                      ) : (
                        <div className="space-y-1">
                          {entries.map(([k, v]) => (
                            <div key={k} className="flex items-center gap-1.5 group">
                              <span className="text-[11px] font-mono text-zinc-500 truncate min-w-0">{k}</span>
                              <span className="text-[10px] text-zinc-700">=</span>
                              <span className="text-[11px] font-mono text-zinc-400 truncate min-w-0 flex-1">{v}</span>
                              <button
                                onClick={() => {
                                  const next = { ...asset.customMetadata };
                                  delete next[k];
                                  saveMetadata(next);
                                }}
                                disabled={metaSaving}
                                className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded text-zinc-600 hover:text-red-400 transition-all cursor-pointer disabled:opacity-50"
                                title={t.common.remove}
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                    {Object.keys(asset.customMetadata ?? {}).length < 10 && (
                      <form
                        className="flex items-center gap-1.5 mt-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const key = metaKey.trim();
                          const value = metaValue.trim();
                          if (!key || !value) return;
                          const current = asset.customMetadata ?? {};
                          if (Object.keys(current).length >= 10) return;
                          saveMetadata({ ...current, [key]: value });
                          setMetaKey('');
                          setMetaValue('');
                        }}
                      >
                        <input
                          type="text"
                          value={metaKey}
                          onChange={(e) => setMetaKey(e.target.value)}
                          placeholder={t.videoDetail.metadataKey}
                          maxLength={255}
                          className="w-20 flex-1 text-[11px] px-1.5 py-1 rounded bg-zinc-800/60 border border-zinc-700/50 text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-600"
                        />
                        <input
                          type="text"
                          value={metaValue}
                          onChange={(e) => setMetaValue(e.target.value)}
                          placeholder={t.videoDetail.metadataValue}
                          maxLength={255}
                          className="w-20 flex-1 text-[11px] px-1.5 py-1 rounded bg-zinc-800/60 border border-zinc-700/50 text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-600"
                        />
                        <button
                          type="submit"
                          disabled={metaSaving || !metaKey.trim() || !metaValue.trim()}
                          className="text-[10px] font-medium px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
                        >
                          {metaSaving ? '...' : t.videoDetail.addMetadata}
                        </button>
                      </form>
                    )}
                    <div className="text-[9px] text-zinc-700 mt-1">{t.videoDetail.metadataLimit}</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Renditions — collapsible */}
          {asset.renditions.length > 0 && (
            <div className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
              <button
                onClick={() => setRenditionsOpen(!renditionsOpen)}
                className="w-full flex items-center justify-between cursor-pointer"
              >
                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                  {t.videoDetail.renditions}
                  <span className="ml-2 text-zinc-600 normal-case font-normal">{asset.renditions.length} {t.videoDetail.qualities}</span>
                </h3>
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={`text-zinc-600 transition-transform ${renditionsOpen ? 'rotate-180' : ''}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {renditionsOpen && (
                <div className="space-y-2 mt-3">
                  {[...asset.renditions].sort((a, b) => b.height - a.height).map((r) => {
                    const size = r.fileSizeBytes ?? (asset.durationSec ? estimateRenditionSize(r.bitrateKbps, asset.durationSec) : null);
                    return (
                      <div key={r.id} className="flex items-center justify-between py-1.5">
                        <span className="text-xs font-semibold text-zinc-200">{r.quality}</span>
                        <span className="text-xs text-zinc-500">
                          {r.width}x{r.height} &middot;{' '}
                          {r.bitrateKbps >= 1000 ? `${(r.bitrateKbps / 1000).toFixed(0)}M` : `${r.bitrateKbps}k`}
                          {size ? ` \u00b7 ${r.fileSizeBytes ? '' : '~'}${formatFileSize(size)}` : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Analytics - full width below */}
      {isReady && (
        <div className="mt-8">
          <AssetAnalytics assetId={id!} />
        </div>
      )}

      {/* Embed Modal */}
      {isReady && (
        <ShareModal
          open={embedOpen}
          onClose={() => setEmbedOpen(false)}
          asset={asset}
          manifest={manifest}
        />
      )}

      {/* Settings Modal */}
      <VideoSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        asset={asset}
        onSaved={() => fetchAsset()}
      />
    </>
  );
}

/* ─── Sub-components ──────────────────────────────────────── */

/** Build a compact step list that only includes transcoding qualities
 *  up to the highest one seen so far (avoids showing 4320p dots for a 720p video). */
function getVisibleSteps(currentStep: string | null | undefined, allSteps: { key: string; label: string }[]): { key: string; label: string }[] {
  if (!currentStep) return allSteps.filter(s => !s.key.startsWith('transcoding_'));

  const activeIdx = allSteps.findIndex(s => s.key === currentStep);

  // Find the highest transcoding step that is at or before the current step
  let lastTranscodeIdx = -1;
  for (let i = Math.min(activeIdx >= 0 ? activeIdx : allSteps.length - 1, allSteps.length - 1); i >= 0; i--) {
    if (allSteps[i].key.startsWith('transcoding_')) { lastTranscodeIdx = i; break; }
  }

  return allSteps.filter((s, i) => {
    if (!s.key.startsWith('transcoding_')) return true;
    // Show transcoding steps up to the highest one reached (+ 1 for the next expected)
    return i <= lastTranscodeIdx + 1;
  });
}

function StatusHero({ status, errorMessage, currentStep, t }: { status: string; errorMessage: string | null; currentStep?: string | null; t: Translations }) {
  if (status === 'error') {
    return (
      <div className="relative w-full rounded-xl overflow-hidden bg-red-500/5 border border-red-500/20" style={{ aspectRatio: '16/9' }}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
          <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-red-400">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-red-400">{t.videoDetail.transcodingFailed}</p>
            {errorMessage && (
              <p className="text-xs text-red-400/70 mt-1.5 max-w-md">{errorMessage}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (status === 'processing') {
    const allSteps = getAllProcessingSteps(t);
    const steps = getVisibleSteps(currentStep, allSteps);
    const activeIdx = currentStep ? steps.findIndex(s => s.key === currentStep) : -1;
    const stepLabel = activeIdx >= 0 ? steps[activeIdx].label : t.videoDetail.starting;

    return (
      <div className="relative w-full rounded-xl overflow-hidden bg-zinc-900/80 border border-zinc-800/60" style={{ aspectRatio: '16/9' }}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6">
          {/* Spinner */}
          <div className="relative w-16 h-16">
            <svg className="w-16 h-16 animate-spin" viewBox="0 0 64 64" style={{ animationDuration: '2.5s' }}>
              <circle cx="32" cy="32" r="28" fill="none" stroke="rgb(39 39 42)" strokeWidth="3" />
              <circle cx="32" cy="32" r="28" fill="none" strokeWidth="3" strokeLinecap="round" stroke="rgb(234 88 12)" strokeDasharray="100 176" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs font-bold text-accent-400">{activeIdx >= 0 ? `${Math.round(((activeIdx + 0.5) / steps.length) * 100)}%` : '...'}</span>
            </div>
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-zinc-200">{stepLabel}</p>
          </div>
          {/* Step dots */}
          <div className="flex items-center gap-1">
            {steps.map((step, i) => (
              <div
                key={step.key}
                title={step.label}
                className={`h-1.5 rounded-full transition-all duration-500 ${
                  i < activeIdx
                    ? 'w-5 bg-accent-500'
                    : i === activeIdx
                      ? 'w-5 bg-accent-400 animate-pulse'
                      : 'w-1.5 bg-zinc-700'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (status === 'queued') {
    return (
      <div className="relative w-full rounded-xl overflow-hidden bg-zinc-900/80 border border-zinc-800/60" style={{ aspectRatio: '16/9' }}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6">
          {/* Pulsing queue icon */}
          <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center animate-pulse">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-amber-400">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-zinc-200">{t.videoDetail.queuedForTranscoding}</p>
            <p className="text-xs text-zinc-500 mt-1">{t.videoDetail.waitingForWorker}</p>
          </div>
          {/* Bouncing dots */}
          <div className="flex items-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-amber-400"
                style={{
                  animation: 'bounce-dot 1.4s ease-in-out infinite',
                  animationDelay: `${i * 0.2}s`,
                }}
              />
            ))}
          </div>
        </div>
        <style>{`
          @keyframes bounce-dot {
            0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
            40% { opacity: 1; transform: scale(1.2); }
          }
        `}</style>
      </div>
    );
  }

  // created / uploaded — waiting to start
  return (
    <div className="relative w-full rounded-xl overflow-hidden bg-zinc-900/80 border border-zinc-800/60" style={{ aspectRatio: '16/9' }}>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
        <div className="w-16 h-16 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 9l6 6M15 9l-6 6" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-zinc-300">{t.videoDetail.waitingForUpload}</p>
          <p className="text-xs text-zinc-600 mt-1">{t.videoDetail.notProcessed}</p>
        </div>
      </div>
    </div>
  );
}

/* ─── DevIdRow ───────────────────────────────────────────── */

function DevIdRow({ label, value, t }: { label: string; value: string | null; t: Translations }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-0.5">{label}</div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-mono text-zinc-400 truncate select-all">{value}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className={`shrink-0 p-1 rounded transition-colors cursor-pointer ${
            copied ? 'text-emerald-400' : 'text-zinc-600 hover:text-zinc-400'
          }`}
          title={copied ? t.common.copied : t.common.copy}
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
        </button>
      </div>
    </div>
  );
}

/* ─── ThumbnailButton (overlay on player) ────────────────── */

function ThumbnailButton({ assetId, onUpdated, t }: { assetId: string; onUpdated: () => void; t: Translations }) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      await api(`/v1/assets/${assetId}/thumbnail`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
        raw: true,
      });
      onUpdated();
    } catch {
      // silently fail
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
        disabled={uploading}
        className="absolute top-3 right-3 z-10 flex items-center gap-1.5 px-2.5 h-7 rounded-lg bg-black/60 backdrop-blur-sm text-white text-[11px] font-medium opacity-0 group-hover/player:opacity-100 transition-opacity duration-200 hover:bg-black/80 cursor-pointer"
      >
        {uploading ? (
          <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
        )}
        {t.videoDetail.thumbnail}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = '';
        }}
      />
    </>
  );
}

/* ─── AiFeatureRow ──────────────────────────────────────── */

function AiFeatureRow({ label, status, t }: { label: string; status: string; t: Translations }) {
  const aiRowCfg = getAiRowCfg(t);
  const c = aiRowCfg[status] ?? aiRowCfg.pending;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-400">{label}</span>
      <div className={`flex items-center gap-1 text-[11px] ${c.color}`}>
        {status === 'completed' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
        )}
        {status === 'processing' && (
          <div className="w-3 h-3 rounded-full border-2 border-blue-500/30 border-t-blue-400 animate-spin" />
        )}
        {status === 'failed' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        )}
        {c.label}
      </div>
    </div>
  );
}
