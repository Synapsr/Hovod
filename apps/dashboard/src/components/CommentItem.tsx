import { useState } from 'react';
import type { Comment } from '../lib/types.js';
import { timeAgo, formatTime } from '../lib/helpers.js';

interface CommentItemProps {
  comment: Comment;
  onSeek: (time: number) => void;
  dark: boolean;
  accentColor: string;
  isNew?: boolean;
}

export function CommentItem({ comment, onSeek, dark, accentColor, isNew }: CommentItemProps) {
  const [imgError, setImgError] = useState(false);
  const gravatarUrl = `https://www.gravatar.com/avatar/${comment.emailHash}?d=mp&s=80`;

  const initials = comment.authorName
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div
      className={`group flex gap-3.5 px-1 py-3.5 rounded-xl transition-all ${
        isNew ? 'animate-[fadeSlideIn_0.3s_ease-out]' : ''
      } ${dark ? 'hover:bg-zinc-800/30' : 'hover:bg-zinc-50'}`}
    >
      {/* Avatar */}
      {imgError ? (
        <div
          className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-[11px] font-semibold text-white"
          style={{ backgroundColor: accentColor + 'cc' }}
        >
          {initials}
        </div>
      ) : (
        <img
          src={gravatarUrl}
          alt=""
          className={`w-9 h-9 rounded-full shrink-0 object-cover ${dark ? 'ring-1 ring-zinc-800' : 'ring-1 ring-zinc-200/60'}`}
          loading="lazy"
          onError={() => setImgError(true)}
        />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-[13px] font-semibold leading-tight ${dark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {comment.authorName}
          </span>
          {comment.timestampSec !== null && (
            <button
              onClick={() => onSeek(comment.timestampSec!)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold transition-all hover:brightness-110 active:scale-95"
              style={{
                backgroundColor: accentColor + '15',
                color: accentColor,
              }}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              {formatTime(comment.timestampSec)}
            </button>
          )}
          <span className={`text-[11px] ${dark ? 'text-zinc-600' : 'text-zinc-400'}`}>
            {timeAgo(comment.createdAt)}
          </span>
        </div>

        <p className={`text-[13px] leading-relaxed mt-1 whitespace-pre-wrap break-words ${dark ? 'text-zinc-300' : 'text-zinc-600'}`}>
          {comment.body}
        </p>
      </div>
    </div>
  );
}
