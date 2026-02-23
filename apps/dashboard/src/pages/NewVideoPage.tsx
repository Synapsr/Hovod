import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n/index.js';
import type { AiOptions, ServerConfig } from '../lib/types.js';

type SourceTab = 'upload' | 'import';
type Phase = 'idle' | 'creating' | 'uploading' | 'imported' | 'processing' | 'done' | 'error';

export function NewVideoPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [sourceTab, setSourceTab] = useState<SourceTab>('upload');
  const [importUrl, setImportUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [aiOptions, setAiOptions] = useState<AiOptions>({ transcription: true, subtitles: true, chapters: true });
  const inputRef = useRef<HTMLInputElement>(null);
  const assetIdRef = useRef<string | null>(null);
  const { t } = useT();

  // Fetch server config on mount
  useEffect(() => {
    api<ServerConfig>('/v1/config').then(setConfig).catch(() => {});
  }, []);

  const hasSource = sourceTab === 'upload' ? !!file : !!importUrl;
  const canStart = hasSource && phase === 'idle';

  const handleFileSelect = useCallback((f: File) => {
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^/.]+$/, ''));
    setError('');
  }, [title]);

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

    try {
      // Step 1: Create asset
      setPhase('creating');
      const assetTitle = title || (sourceTab === 'upload' && file ? file.name.replace(/\.[^/.]+$/, '') : 'Imported video');
      const { id } = await api<{ id: string }>('/v1/assets', {
        method: 'POST',
        body: JSON.stringify({ title: assetTitle }),
      });
      assetIdRef.current = id;

      if (sourceTab === 'upload' && file) {
        // Step 2a: Get presigned URL and upload directly to S3
        setPhase('uploading');
        const { uploadUrl } = await api<{ uploadUrl: string }>(`/v1/assets/${id}/upload-url`, {
          method: 'POST',
        });
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', uploadUrl);
          xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => (xhr.status < 400 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(file);
        });
        // Confirm the S3 upload completed (verifies file exists)
        await api(`/v1/assets/${id}/upload-complete`, { method: 'POST' });
      } else {
        // Step 2b: Import from URL
        setPhase('imported');
        await api(`/v1/assets/${id}/import`, {
          method: 'POST',
          body: JSON.stringify({ sourceUrl: importUrl }),
        });
      }

      // Step 3: Start processing with AI options
      setPhase('processing');
      const body = config?.aiAvailable ? { aiOptions } : undefined;
      await api(`/v1/assets/${id}/process`, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });

      setPhase('done');
      navigate(`/videos/${id}`);
    } catch (err: unknown) {
      setPhase('error');
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    }
  }, [canStart, title, sourceTab, file, importUrl, aiOptions, config, navigate, t]);

  const isWorking = phase !== 'idle' && phase !== 'error';

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
              <span>{t.common.uploading}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent-500 rounded-full transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
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
          <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {/* Action */}
        <button
          onClick={handleStart}
          disabled={!canStart}
          className="h-10 px-5 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t.videos.startProcessing}
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
