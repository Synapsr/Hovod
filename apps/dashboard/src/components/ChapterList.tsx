import { useEffect, useState } from 'react';
import type { Chapter } from '../lib/types.js';
import { formatTime } from '../lib/helpers.js';
import { InlineEdit } from './InlineEdit.js';

interface ChapterListProps {
  chapters: Chapter[];
  onSeek: (time: number) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  dark?: boolean;
  label?: string;
  canEdit?: boolean;
  onChapterTitleChange?: (index: number, newTitle: string) => Promise<void>;
}

export function ChapterList({ chapters, onSeek, videoRef, dark = false, label = 'Chapters', canEdit = false, onChapterTitleChange }: ChapterListProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const onTimeUpdate = () => {
      const t = el.currentTime;
      for (let i = chapters.length - 1; i >= 0; i--) {
        if (t >= chapters[i].startTime) {
          setActiveIndex(i);
          return;
        }
      }
      setActiveIndex(0);
    };

    el.addEventListener('timeupdate', onTimeUpdate);
    return () => el.removeEventListener('timeupdate', onTimeUpdate);
  }, [chapters, videoRef]);

  return (
    <div>
      <h3 className={`text-[11px] font-semibold uppercase tracking-widest mb-3 ${
        dark ? 'text-zinc-500' : 'text-zinc-400'
      }`}>
        {label}
      </h3>
      <div className="space-y-0.5">
        {chapters.map((ch, i) => {
          const isActive = i === activeIndex;
          return (
            <div
              key={i}
              onClick={() => onSeek(ch.startTime)}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 text-sm group cursor-pointer ${
                isActive
                  ? dark
                    ? 'bg-accent-500/10 text-accent-500'
                    : 'bg-accent-50 text-accent-700'
                  : dark
                    ? 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                    : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
              }`}
            >
              <div className="flex items-start gap-3">
                <span className={`text-[11px] tabular-nums shrink-0 pt-px ${
                  isActive
                    ? dark ? 'text-accent-400' : 'text-accent-500'
                    : dark ? 'text-zinc-600 group-hover:text-zinc-500' : 'text-zinc-400 group-hover:text-zinc-500'
                }`}>
                  {formatTime(ch.startTime)}
                </span>
                {canEdit && onChapterTitleChange ? (
                  <span onClick={(e) => e.stopPropagation()}>
                    <InlineEdit
                      value={ch.title}
                      onSave={async (newTitle) => { await onChapterTitleChange(i, newTitle); }}
                      dark={dark}
                      className="font-medium leading-snug"
                    />
                  </span>
                ) : (
                  <span className="font-medium leading-snug">{ch.title}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
