import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import {
  abortUpload,
  isAbortError,
  MAX_UPLOAD_LABEL,
  uploadVideoFile,
  validateVideoFile,
  type UploadProgress,
} from '../lib/upload.js';
import { useT } from '../lib/i18n/index.js';
import type { AiOptions, ServerConfig } from '../lib/types.js';

type SourceTab = 'upload' | 'import';
type Phase = 'idle' | 'creating' | 'uploading' | 'imported' | 'processing' | 'done' | 'error';

export function NewVideoPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [sourceTab, setSourceTab] = useState<SourceTab>('upload');
  const [importUrl, setImportUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [aiOptions, setAiOptions] = useState<AiOptions>({ transcription: true, subtitles: true, chapters: true });
  const inputRef = useRef<HTMLInputElement>(null);
  // Kept across a Retry so the same asset (and multipart upload) is reused.
  const assetIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { t } = useT();

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api<ServerConfig>('/v1/config'),
    staleTime: 5 * 60_000,
  });

  const hasSource = sourceTab === 'upload' ? !!file : !!importUrl;
  const isWorking = phase !== 'idle' && phase !== 'error';
  const canStart = hasSource && !isWorking;
  const isRetry = phase === 'error' && assetIdRef.current !== null;

  /* Warn before leaving while bytes are still in flight */
  useEffect(() => {
    if (phase !== 'uploading') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = t.videos.leaveWarning;
      return t.videos.leaveWarning;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase, t]);

  /* Stop an in-flight upload if the page goes away */
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleFileSelect = useCallback((f: File) => {
    const rejection = validateVideoFile(f);
    if (rejection === 'type') { setError(t.videos.invalidFileType); return; }
    if (rejection === 'size') { setError(t.videos.fileTooLarge.replace('{max}', MAX_UPLOAD_LABEL)); return; }

    // A different file cannot reuse the asset a previous attempt created.
    const previousAsset = assetIdRef.current;
    if (previousAsset) {
      assetIdRef.current = null;
      abortUpload(previousAsset).catch(() => {});
    }
    setFile(f);
    setProgress(null);
    setPhase('idle');
    if (!title) setTitle(f.name.replace(/\.[^/.]+$/, ''));
    setError('');
  }, [title, t]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileSelect(f);
  }, [handleFileSelect]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFileSelect(f);
    e.target.value = '';
  }, [handleFileSelect]);

  const handleStart = useCallback(async () => {
    if (!canStart) return;
    setError('');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Step 1: create the asset — unless a previous attempt already made one.
      let id = assetIdRef.current;
      if (!id) {
        setPhase('creating');
        const assetTitle = title || (sourceTab === 'upload' && file ? file.name.replace(/\.[^/.]+$/, '') : 'Imported video');
        const created = await api<{ id: string }>('/v1/assets', {
          method: 'POST',
          body: JSON.stringify({ title: assetTitle }),
        });
        id = created.id;
        assetIdRef.current = id;
      }

      if (sourceTab === 'upload' && file) {
        // Step 2a: upload to S3 (multipart above 16 MB, resumes completed parts)
        setPhase('uploading');
        await uploadVideoFile({
          assetId: id,
          file,
          signal: controller.signal,
          onProgress: setProgress,
        });
      } else {
        // Step 2b: import from URL
        setPhase('imported');
        await api(`/v1/assets/${id}/import`, {
          method: 'POST',
          body: JSON.stringify({ sourceUrl: importUrl }),
        });
      }

      // Step 3: start processing with AI options
      setPhase('processing');
      const body = config?.aiAvailable ? { aiOptions } : undefined;
      await api(`/v1/assets/${id}/process`, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });

      setPhase('done');
      queryClient.invalidateQueries({ queryKey: ['assets'] });
      navigate(`/videos/${id}`);
    } catch (err: unknown) {
      if (isAbortError(err)) {
        setPhase('idle');
        setProgress(null);
        return;
      }
      setPhase('error');
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      abortRef.current = null;
    }
  }, [canStart, title, sourceTab, file, importUrl, aiOptions, config, navigate, queryClient, t]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    const id = assetIdRef.current;
    if (id) abortUpload(id).catch(() => {});
  }, []);

  return (
    <>
      {/* Header */}
      <div className="mb-8 flex items-center gap-4">
        <button
          onClick={() => navigate('/videos')}
          className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          {t.nav.videos}
        </button>
        <h1 className="text-lg font-semibold text-zinc-50">{t.videos.newVideo}</h1>
      </div>

      <div className="max-w-2xl">
        {/* Source tabs */}
        <div className="mb-6">
          <label className="block text-xs font-medium text-zinc-400 mb-2">{t.videos.source}</label>
          <div className="flex gap-1 mb-3 p-1 bg-zinc-900 rounded-lg w-fit">
            <button
              onClick={() => !isWorking && setSourceTab('upload')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sourceTab === 'upload'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.videos.uploadFile}
            </button>
            <button
              onClick={() => !isWorking && setSourceTab('import')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sourceTab === 'import'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.videos.importUrl}
            </button>
          </div>

          {sourceTab === 'upload' ? (
            <div
              role="button"
              tabIndex={0}
              aria-label={t.videos.uploadVideo}
              className={`border-2 border-dashed rounded-xl py-10 px-6 text-center cursor-pointer transition-all ${
                isWorking ? 'pointer-events-none opacity-50' : ''
              } ${
                dragOver
                  ? 'border-accent-500 bg-accent-500/5'
                  : file
                    ? 'border-zinc-700 bg-zinc-900/60'
                    : 'border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/40'
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
            >
              <input ref={inputRef} type="file" accept="video/*" hidden onChange={onFileChange} />
              {file ? (
                <div>
                  <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-accent-500/10 flex items-center justify-center text-accent-400">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </div>
                  <p className="text-sm text-zinc-200 font-medium">{file.name}</p>
                  <p className="text-xs text-zinc-500 mt-1">{(file.size / (1024 * 1024)).toFixed(1)} MB</p>
                </div>
              ) : (
                <div>
                  <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500">
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M10 14V3M10 3l4 4M10 3L6 7" />
                      <path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2" />
                    </svg>
                  </div>
                  <p className="text-sm text-zinc-400">{t.videos.dragDrop}</p>
                  <p className="text-xs text-zinc-600 mt-1">{t.videos.fileTypes}</p>
                </div>
              )}
            </div>
          ) : (
            <input
              type="text"
              placeholder={t.videos.urlPlaceholder}
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              disabled={isWorking}
              className="w-full h-10 px-3 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors disabled:opacity-50"
            />
          )}
        </div>

        {/* Title — shown after source is selected */}
        {hasSource && (
          <div className="mb-6">
            <label className="block text-xs font-medium text-zinc-400 mb-2">{t.videoSettings.titleLabel}</label>
            <input
              type="text"
              placeholder={t.videos.enterTitle}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isWorking}
              className="w-full h-10 px-3 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors disabled:opacity-50"
            />
          </div>
        )}

        {/* AI Options */}
        {config?.aiAvailable && (
          <div className="mb-6">
            <label className="block text-xs font-medium text-zinc-400 mb-3">{t.videos.aiProcessing}</label>
            <div className="space-y-3">
              <Toggle
                label={t.videos.subtitles}
                description={t.videos.subtitlesDesc}
                checked={aiOptions.subtitles}
                onChange={(v) => setAiOptions({ ...aiOptions, subtitles: v, transcription: v || aiOptions.chapters })}
                disabled={isWorking}
              />
              {config.chaptersAvailable && (
                <Toggle
                  label={t.videos.chapters}
                  description={t.videos.chaptersDesc}
                  checked={aiOptions.chapters}
                  onChange={(v) => setAiOptions({ ...aiOptions, chapters: v, transcription: v || aiOptions.subtitles })}
                  disabled={isWorking}
                />
              )}
            </div>
          </div>
        )}

        {/* Progress */}
        {phase === 'uploading' && (
          <div className="mb-6">
            <div className="flex items-center justify-between text-xs text-zinc-400 mb-2">
              <span>
                {!progress
                  ? t.videos.preparingUpload
                  : progress.totalParts > 1
                    ? t.videos.uploadingParts
                        .replace('{done}', String(progress.completedParts))
                        .replace('{total}', String(progress.totalParts))
                    : t.common.uploading}
              </span>
              <span className="tabular-nums">{progress?.percent ?? 0}%</span>
            </div>
            <div
              className="h-1.5 bg-zinc-800 rounded-full overflow-hidden"
              role="progressbar"
              aria-valuenow={progress?.percent ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full bg-accent-500 rounded-full transition-[width] duration-300"
                style={{ width: `${progress?.percent ?? 0}%` }}
              />
            </div>
            <button
              onClick={handleCancel}
              className="mt-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {t.common.cancel}
            </button>
          </div>
        )}
        {phase === 'creating' && (
          <p className="text-xs text-zinc-500 mb-6">{t.videos.creatingAsset}</p>
        )}
        {phase === 'imported' && (
          <p className="text-xs text-zinc-500 mb-6">{t.videos.importingVideo}</p>
        )}
        {phase === 'processing' && (
          <p className="text-xs text-zinc-500 mb-6">{t.videos.startingTranscoding}</p>
        )}

        {/* Error */}
        {error && (
          <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20" role="alert">
            {phase === 'error' && sourceTab === 'upload' && (
              <p className="text-xs font-medium text-red-300 mb-0.5">{t.videos.uploadFailed}</p>
            )}
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {/* Action */}
        <button
          onClick={handleStart}
          disabled={!canStart}
          className="h-10 px-5 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isRetry ? t.videos.retryUpload : t.videos.startProcessing}
        </button>
      </div>
    </>
  );
}

/* ─── Toggle component ─────────────────────────────────── */

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center justify-between gap-4 p-3 rounded-lg border transition-colors cursor-pointer ${
      disabled
        ? 'border-zinc-800/50 opacity-50 cursor-not-allowed'
        : checked
          ? 'border-zinc-800 bg-zinc-900/60'
          : 'border-zinc-800/50 hover:border-zinc-700'
    }`}>
      <div className="min-w-0">
        <p className="text-sm text-zinc-200">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={(e) => { e.preventDefault(); if (!disabled) onChange(!checked); }}
        className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
          checked ? 'bg-accent-600' : 'bg-zinc-700'
        }`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : ''
        }`} />
      </button>
    </label>
  );
}
