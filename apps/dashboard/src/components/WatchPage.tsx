import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { PlaybackData, Transcript, Chapter, Comment } from '../lib/types.js';
import { Player } from './Player.js';
import type { CommentMarker } from './Player.js';
import { ChapterList } from './ChapterList.js';
import { TranscriptPanel } from './TranscriptPanel.js';
import { CommentSection } from './CommentSection.js';
import { VideoSettingsModal } from './VideoSettingsModal.js';
import type { AssetDetail } from '../lib/types.js';
import { ReactionBar } from './ReactionBar.js';
import { IdentityModal, getSavedIdentity, clearIdentity } from './IdentityModal.js';
import type { UserIdentity } from './IdentityModal.js';
import { applyAccentColor } from '../lib/settings-context.js';
import DOMPurify from 'dompurify';
import { useT, LOCALES } from '../lib/i18n/index.js';

/* ─── Meta tags ───────────────────────────────────────────── */

function useDocumentMeta(title: string | undefined, description?: string) {
  useEffect(() => {
    if (!title) return;
    document.title = title;

    const setMeta = (name: string, content: string) => {
      let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement('meta');
        el.name = name;
        document.head.appendChild(el);
      }
      el.content = content;
    };

    const setOg = (property: string, content: string) => {
      let el = document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute('property', property);
        document.head.appendChild(el);
      }
      el.content = content;
    };

    const desc = description || title;
    setMeta('description', desc);
    setOg('og:title', title);
    setOg('og:description', desc);
    setOg('og:type', 'video.other');
    setOg('og:url', window.location.href);
  }, [title, description]);
}

/* ─── WatchPage ───────────────────────────────────────────── */

export function WatchPage() {
  const { playbackId = '' } = useParams<{ playbackId: string }>();
  const [data, setData] = useState<PlaybackData | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [error, setError] = useState('');
  const [dark, setDark] = useState<boolean | null>(null);
  const [accentColor, setAccentColor] = useState('#6366f1');
  const [vttVersion, setVttVersion] = useState(0);
  const [comments, setComments] = useState<Comment[]>([]);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Identity management
  const [identity, setIdentity] = useState<UserIdentity | null>(getSavedIdentity);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const pendingActionRef = useRef<((id: UserIdentity) => void) | null>(null);

  const { t, locale, setLocale } = useT();

  const commentMarkers = useMemo<CommentMarker[]>(() => {
    const timestamped = comments.filter((c) => c.timestampSec !== null);
    const grouped = new Map<number, { timestampSec: number; authorName: string; body: string; count: number }>();
    for (const c of timestamped) {
      const bucket = Math.round(c.timestampSec! / 2) * 2;
      if (!grouped.has(bucket)) {
        grouped.set(bucket, { timestampSec: c.timestampSec!, authorName: c.authorName, body: c.body, count: 1 });
      } else {
        grouped.get(bucket)!.count++;
      }
    }
    return Array.from(grouped.values()).map((g) => ({
      timestampSec: g.timestampSec,
      authorName: g.count > 1 ? `${g.count} comments` : g.authorName,
      body: g.count > 1 ? `${g.authorName}: ${g.body}` : g.body,
    }));
  }, [comments]);

  const handleCommentsLoaded = useCallback((loaded: Comment[]) => {
    setComments(loaded);
  }, []);

  // Request identity — show modal, execute action after confirm
  const requireIdentity = useCallback((action: (id: UserIdentity) => void) => {
    const saved = getSavedIdentity();
    if (saved) {
      setIdentity(saved);
      action(saved);
    } else {
      pendingActionRef.current = action;
      setShowIdentityModal(true);
    }
  }, []);

  const handleIdentityConfirm = useCallback((id: UserIdentity) => {
    setIdentity(id);
    setShowIdentityModal(false);
    if (pendingActionRef.current) {
      pendingActionRef.current(id);
      pendingActionRef.current = null;
    }
  }, []);

  const handleRequestIdentity = useCallback(() => {
    setShowIdentityModal(true);
  }, []);

  const handleClearIdentity = useCallback(() => {
    clearIdentity();
    setIdentity(null);
  }, []);

  // Handle emoji reaction — post as a comment
  const handleReact = useCallback((emoji: string) => {
    requireIdentity(async (id) => {
      try {
        const timestampSec = videoRef.current ? Math.floor(videoRef.current.currentTime) : undefined;
        const newComment = await api<Comment>(`/v1/playback/${playbackId}/comments`, {
          method: 'POST',
          body: JSON.stringify({
            authorName: id.name,
            authorEmail: id.email,
            body: emoji,
            timestampSec,
          }),
        });
        setComments((prev) => {
          const updated = [newComment, ...prev];
          return updated;
        });
      } catch {
        // silently fail
      }
    });
  }, [playbackId, requireIdentity]);

  useDocumentMeta(data?.title);

  useEffect(() => {
    api<PlaybackData>(`/v1/playback/${playbackId}`)
      .then((d) => {
        setData(d);
        if (d.settings) {
          setDark(d.settings.theme === 'dark');
          setAccentColor(d.settings.primaryColor);
          applyAccentColor(d.settings.primaryColor);
        } else {
          setDark(false);
        }
        if (d.ai?.transcriptUrl) {
          fetch(d.ai.transcriptUrl).then(r => r.json()).then(setTranscript).catch(() => {});
        }
        if (d.ai?.chaptersUrl) {
          fetch(d.ai.chaptersUrl).then(r => r.json()).then(c => setChapters(c.chapters || [])).catch(() => {});
        }
      })
      .catch(() => {
        setError('not_found');
        setDark(false);
      });
  }, [playbackId]);

  const seekTo = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      videoRef.current.play().catch(() => {});
    }
  }, []);

  const canEdit = data?.canEdit ?? false;

  const handleSettingsSaved = useCallback(() => {
    api<PlaybackData>(`/v1/playback/${playbackId}`)
      .then((d) => {
        setData(d);
      })
      .catch(() => {});
  }, [playbackId]);

  const handleChapterTitleChange = useCallback(async (index: number, newTitle: string) => {
    if (!data) return;
    const updated = chapters.map((ch, i) => i === index ? { ...ch, title: newTitle } : ch);
    await api(`/v1/assets/${data.assetId}/chapters`, { method: 'PATCH', body: JSON.stringify({ chapters: updated }) });
    setChapters(updated);
  }, [data, chapters]);

  const handleSegmentTextChange = useCallback(async (segId: number, newText: string) => {
    if (!data || !transcript) return;
    const updatedSegments = transcript.segments.map(s => s.id === segId ? { ...s, text: newText } : s);
    const updatedTranscript = { ...transcript, segments: updatedSegments, text: updatedSegments.map(s => s.text).join(' ') };
    await api(`/v1/assets/${data.assetId}/transcript`, { method: 'PATCH', body: JSON.stringify({ transcript: updatedTranscript }) });
    setTranscript(updatedTranscript);
    setVttVersion(v => v + 1);
  }, [data, transcript]);

  const isDark = dark ?? false;

  /* Error state */
  if (error) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
        <div className="text-center">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${isDark ? 'bg-zinc-900' : 'bg-zinc-100'}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>
              <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" />
            </svg>
          </div>
          <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{t.watch.videoNotFound}</p>
        </div>
      </div>
    );
  }

  /* Loading state */
  if (!data || dark === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="flex items-center gap-2.5 text-sm text-zinc-500">
          <div className="w-4 h-4 rounded-full border-2 animate-spin border-zinc-700 border-t-zinc-400" />
          {t.watch.loading}
        </div>
      </div>
    );
  }

  const hasChapters = chapters.length > 0 && data.publicSettings?.showChapters !== false;
  const hasTranscript = transcript !== null && data.publicSettings?.showTranscript !== false;
  const allowDownload = data.publicSettings?.allowDownload === true;
  const showComments = data.publicSettings?.showComments !== false;

  return (
    <div className={`min-h-screen flex flex-col ${isDark ? 'bg-zinc-950 text-zinc-50' : 'bg-white text-zinc-900'}`}>
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
        {/* Logo + Title + Description */}
        <div className="mb-6">
          <div className="flex items-center gap-4">
            {data.settings?.logoUrl && (
              <img
                src={data.settings.logoUrl}
                alt=""
                className="h-9 object-contain shrink-0"
              />
            )}
            {data.title && (
              <h1 className={`text-2xl font-semibold tracking-tight ${isDark ? 'text-zinc-50' : 'text-zinc-900'}`}>
                {data.title}
              </h1>
            )}
            {canEdit && (
              <button
                onClick={() => setShowSettingsModal(true)}
                className={`ml-auto flex items-center gap-1.5 px-3 h-8 text-xs font-medium rounded-lg transition-colors shrink-0 ${
                  isDark
                    ? 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                    : 'bg-zinc-100 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  <path d="m15 5 4 4" />
                </svg>
                {t.common.edit}
              </button>
            )}
          </div>
        </div>

        {/* Video + Chapters layout */}
        <div className={hasChapters ? 'flex gap-8' : 'max-w-5xl mx-auto'}>
          {/* Main column */}
          <div className={hasChapters ? 'flex-1 min-w-0' : ''}>
            <div className="bg-black rounded-xl overflow-hidden shadow-lg shadow-black/5">
              <Player
                url={data.manifestUrl}
                thumbnailVttUrl={data.thumbnailVttUrl}
                poster={data.thumbnailUrl ?? undefined}
                accentColor={accentColor}
                assetId={data.assetId}
                playbackId={playbackId}
                playerType="embed"
                subtitlesUrl={data.ai?.subtitlesUrl ? `${data.ai.subtitlesUrl}${vttVersion ? `?v=${vttVersion}` : ''}` : undefined}
                externalVideoRef={videoRef}
                commentMarkers={commentMarkers}
                logoUrl={data.settings?.logoUrl ?? undefined}
              />
            </div>

            {/* Actions — below the player */}
            <div className="mt-3 flex items-center justify-between">
              {showComments && <ReactionBar onReact={handleReact} dark={isDark} accentColor={accentColor} />}
              {allowDownload && (
                <button
                  onClick={async () => {
                    try {
                      const { downloadUrl } = await api<{ downloadUrl: string }>(`/v1/playback/${playbackId}/download`);
                      window.open(downloadUrl, '_blank');
                    } catch { /* download not available */ }
                  }}
                  className={`flex items-center gap-1.5 px-3 h-8 text-xs font-medium rounded-lg transition-colors ${
                    isDark
                      ? 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                      : 'bg-zinc-100 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200'
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  {t.common.download}
                </button>
              )}
            </div>

            {/* Description (YouTube-style box) */}
            {data.description && (
              <button
                type="button"
                onClick={() => setDescExpanded(!descExpanded)}
                className={`w-full mt-4 rounded-xl p-3 text-left transition-colors ${
                  isDark
                    ? 'bg-zinc-900 hover:bg-zinc-800/80'
                    : 'bg-zinc-50 hover:bg-zinc-100'
                }`}
              >
                <div
                  className={`text-sm prose prose-sm max-w-none ${
                    isDark ? 'prose-invert' : ''
                  } prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-a:text-accent-500 prose-a:no-underline hover:prose-a:underline ${
                    !descExpanded ? 'line-clamp-3' : ''
                  }`}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(data.description) }}
                />
                {data.description.length > 100 && (
                  <span
                    className={`inline-block mt-1.5 text-xs font-medium transition-colors ${
                      isDark ? 'text-zinc-500' : 'text-zinc-400'
                    }`}
                  >
                    {descExpanded ? t.watch.showLess : t.watch.showMore}
                  </span>
                )}
              </button>
            )}

            {/* Chapters (mobile) */}
            {hasChapters && (
              <div className="lg:hidden mt-6">
                <ChapterList chapters={chapters} onSeek={seekTo} videoRef={videoRef} dark={isDark} label={t.watch.chapters} canEdit={canEdit} onChapterTitleChange={handleChapterTitleChange} />
              </div>
            )}

            {/* Transcript (collapsed by default) */}
            {hasTranscript && (
              <div className="mt-8">
                <button
                  onClick={() => setTranscriptOpen(!transcriptOpen)}
                  className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest transition-colors ${
                    isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'
                  }`}
                >
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    className={`transition-transform duration-200 ${transcriptOpen ? 'rotate-90' : ''}`}
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  {t.watch.transcript}
                </button>
                {transcriptOpen && (
                  <div className="mt-4">
                    <TranscriptPanel
                      transcript={transcript}
                      onSeek={seekTo}
                      videoRef={videoRef}
                      dark={isDark}
                      searchPlaceholder={t.watch.search}
                      noResultsLabel={t.watch.noResults}
                      canEdit={canEdit}
                      onSegmentTextChange={handleSegmentTextChange}
                      hideHeader
                    />
                  </div>
                )}
              </div>
            )}

            {/* Comments */}
            {showComments && <div className="mt-8">
              <CommentSection
                playbackId={playbackId}
                videoRef={videoRef}
                dark={isDark}
                accentColor={accentColor}
                identity={identity}
                onRequestIdentity={handleRequestIdentity}
                onClearIdentity={handleClearIdentity}
                onCommentsLoaded={handleCommentsLoaded}
                onSeek={seekTo}
                labels={{
                  comments: t.watch.comments,
                  addComment: t.watch.addComment,
                  send: t.watch.send,
                  commentingAt: t.watch.commentingAt,
                  noComments: t.watch.noComments,
                  name: t.watch.name,
                  email: t.watch.email,
                }}
              />
            </div>}
          </div>

          {/* Chapter sidebar (desktop, sticky) */}
          {hasChapters && (
            <aside className="hidden lg:block w-72 shrink-0">
              <div className="sticky top-6">
                <ChapterList chapters={chapters} onSeek={seekTo} videoRef={videoRef} dark={isDark} label={t.watch.chapters} canEdit={canEdit} onChapterTitleChange={handleChapterTitleChange} />
              </div>
            </aside>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className={`py-5 px-6 border-t ${isDark ? 'border-zinc-800/60' : 'border-zinc-100'}`}>
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className={`flex items-center gap-1 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
            <span>{t.watch.poweredBy}</span>
            <a href="https://hovod.dev" target="_blank" rel="noopener noreferrer" className={`font-medium transition-colors ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-600 hover:text-zinc-900'}`}>
              Hovod
            </a>
            <span className="mx-1">·</span>
            <span>{t.watch.by}</span>
            <a href="https://synapsr.io" target="_blank" rel="noopener noreferrer" className={`font-medium transition-colors ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-600 hover:text-zinc-900'}`}>
              Synapsr
            </a>
          </div>

          <div className="flex items-center gap-2">
            {/* Language dropdown */}
            <div className="relative">
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as typeof locale)}
                className={`appearance-none h-8 pl-3 pr-7 text-xs font-medium rounded-lg outline-none cursor-pointer transition-colors border ${
                  isDark
                    ? 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                    : 'bg-zinc-50 border-zinc-200 text-zinc-600 hover:border-zinc-300'
                }`}
              >
                {LOCALES.map((l) => (
                  <option key={l} value={l}>{t.locales[l as keyof typeof t.locales]}</option>
                ))}
              </select>
              <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>

            {/* Theme toggle */}
            <button
              onClick={() => setDark(!isDark)}
              className={`p-2 rounded-lg transition-colors ${
                isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
              }`}
              aria-label={isDark ? t.watch.lightMode : t.watch.darkMode}
            >
              {isDark ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5" /><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </footer>

      {/* Identity Modal */}
      <IdentityModal
        open={showIdentityModal}
        onConfirm={handleIdentityConfirm}
        onClose={() => { setShowIdentityModal(false); pendingActionRef.current = null; }}
        dark={isDark}
        accentColor={accentColor}
        labels={{ name: t.watch.name, email: t.watch.email }}
      />

      {/* Video Settings Modal (admin) */}
      {canEdit && showSettingsModal && (
        <VideoSettingsModal
          open={showSettingsModal}
          onClose={() => setShowSettingsModal(false)}
          asset={{
            id: data.assetId,
            title: data.title || '',
            description: data.description,
            status: 'ready',
            playbackId: data.playbackId,
            sourceType: 'upload',
            createdAt: '',
            durationSec: data.durationSec ?? null,
            errorMessage: null,
            thumbnailUrl: null,
            renditions: [],
            publicSettings: data.publicSettings,
          } as AssetDetail}
          onSaved={handleSettingsSaved}
        />
      )}
    </div>
  );
}
