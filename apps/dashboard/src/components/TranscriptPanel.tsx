import { useEffect, useRef, useState } from 'react';
import type { Transcript } from '../lib/types.js';
import { formatTime } from '../lib/helpers.js';
import { InlineEdit } from './InlineEdit.js';

interface TranscriptPanelProps {
  transcript: Transcript;
  onSeek: (time: number) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  dark?: boolean;
  label?: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
  canEdit?: boolean;
  onSegmentTextChange?: (segId: number, newText: string) => Promise<void>;
  hideHeader?: boolean;
}

export function TranscriptPanel({ transcript, onSeek, videoRef, dark = false, label = 'Transcript', searchPlaceholder = 'Search...', noResultsLabel = 'No matches found', canEdit = false, onSegmentTextChange, hideHeader = false }: TranscriptPanelProps) {
  const [search, setSearch] = useState('');
  const [activeSegmentId, setActiveSegmentId] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const onTimeUpdate = () => {
      const t = el.currentTime;
      for (let i = transcript.segments.length - 1; i >= 0; i--) {
        const seg = transcript.segments[i];
        if (t >= seg.start && t < seg.end) {
          if (seg.id !== activeSegmentId) {
            setActiveSegmentId(seg.id);
            if (!search) {
              const ref = segmentRefs.current.get(seg.id);
              if (ref && containerRef.current) {
                const container = containerRef.current;
                const top = ref.offsetTop - container.offsetTop;
                const scrollTop = container.scrollTop;
                const containerHeight = container.clientHeight;
                if (top < scrollTop || top > scrollTop + containerHeight - 60) {
                  container.scrollTo({ top: top - 60, behavior: 'smooth' });
                }
              }
            }
          }
          return;
        }
      }
    };

    el.addEventListener('timeupdate', onTimeUpdate);
    return () => el.removeEventListener('timeupdate', onTimeUpdate);
  }, [transcript.segments, activeSegmentId, search, videoRef]);

  const query = search.toLowerCase();
  const filtered = query
    ? transcript.segments.filter(s => s.text.toLowerCase().includes(query))
    : transcript.segments;

  return (
    <div>
      {!hideHeader ? (
        <div className="flex items-center justify-between mb-4">
          <h3 className={`text-[11px] font-semibold uppercase tracking-widest ${dark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            {label}
            {transcript.language && (
              <span className={`ml-2 normal-case ${dark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                ({transcript.language})
              </span>
            )}
          </h3>
          <div className="relative">
            <svg className={`absolute left-2.5 top-1/2 -translate-y-1/2 ${dark ? 'text-zinc-600' : 'text-zinc-400'}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`h-8 w-48 pl-8 pr-3 text-xs rounded-lg outline-none transition-colors border ${
                dark
                  ? 'bg-zinc-900 border-zinc-800 text-zinc-200 placeholder-zinc-600 focus:border-accent-500/50'
                  : 'bg-zinc-50 border-zinc-200 text-zinc-700 placeholder-zinc-400 focus:border-accent-400'
              }`}
            />
          </div>
        </div>
      ) : (
        <div className="flex justify-end mb-3">
          <div className="relative">
            <svg className={`absolute left-2.5 top-1/2 -translate-y-1/2 ${dark ? 'text-zinc-600' : 'text-zinc-400'}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`h-8 w-48 pl-8 pr-3 text-xs rounded-lg outline-none transition-colors border ${
                dark
                  ? 'bg-zinc-900 border-zinc-800 text-zinc-200 placeholder-zinc-600 focus:border-accent-500/50'
                  : 'bg-zinc-50 border-zinc-200 text-zinc-700 placeholder-zinc-400 focus:border-accent-400'
              }`}
            />
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        className={`max-h-[420px] overflow-y-auto rounded-xl border divide-y ${
          dark
            ? 'border-zinc-800/50 divide-zinc-800/30'
            : 'border-zinc-200/60 divide-zinc-100'
        }`}
      >
        {filtered.map((seg) => {
          const isActive = seg.id === activeSegmentId;
          return (
            <div
              key={seg.id}
              ref={(el) => { if (el) segmentRefs.current.set(seg.id, el); }}
              onClick={() => onSeek(seg.start)}
              className={`flex gap-3 px-4 py-3 cursor-pointer transition-colors duration-150 ${
                isActive
                  ? dark
                    ? 'bg-accent-500/8 text-zinc-100'
                    : 'bg-accent-50 text-zinc-900'
                  : dark
                    ? 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
                    : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
              }`}
            >
              <span className={`text-[11px] tabular-nums shrink-0 pt-0.5 w-10 ${
                isActive
                  ? dark ? 'text-accent-400' : 'text-accent-600'
                  : dark ? 'text-zinc-600' : 'text-zinc-400'
              }`}>
                {formatTime(seg.start)}
              </span>
              {canEdit && !query && onSegmentTextChange ? (
                <span className="text-[13px] leading-relaxed flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                  <InlineEdit
                    value={seg.text.trim()}
                    onSave={async (newText) => { await onSegmentTextChange(seg.id, newText); }}
                    dark={dark}
                    className="text-[13px] leading-relaxed"
                  />
                </span>
              ) : (
                <span className="text-[13px] leading-relaxed">
                  {query ? highlightMatch(seg.text, query, dark) : seg.text.trim()}
                </span>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className={`text-center py-12 text-sm ${dark ? 'text-zinc-600' : 'text-zinc-400'}`}>
            {noResultsLabel}
          </div>
        )}
      </div>
    </div>
  );
}

function highlightMatch(text: string, query: string, dark: boolean): JSX.Element {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.trim().split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className={`rounded-sm px-0.5 ${dark ? 'bg-amber-400/20 text-amber-200' : 'bg-amber-100 text-amber-800'}`}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
