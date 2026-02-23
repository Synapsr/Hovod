import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { Comment, CommentsResponse } from '../lib/types.js';
import type { UserIdentity } from './IdentityModal.js';
import { CommentForm } from './CommentForm.js';
import { CommentList } from './CommentList.js';

interface CommentSectionProps {
  playbackId: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  dark: boolean;
  accentColor: string;
  identity: UserIdentity | null;
  onRequestIdentity: () => void;
  onClearIdentity: () => void;
  onCommentsLoaded: (comments: Comment[]) => void;
  onSeek: (time: number) => void;
  onCommentAdded?: (comment: Comment) => void;
  labels: {
    comments: string;
    addComment: string;
    send: string;
    commentingAt: string;
    noComments: string;
    name: string;
    email: string;
  };
}

export function CommentSection({ playbackId, videoRef, dark, accentColor, identity, onRequestIdentity, onClearIdentity, onCommentsLoaded, onSeek, onCommentAdded, labels }: CommentSectionProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newCommentId, setNewCommentId] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    api<CommentsResponse>(`/v1/playback/${playbackId}/comments?limit=200`)
      .then((data) => {
        setComments(data.comments);
        setTotal(data.total);
        onCommentsLoaded(data.comments);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [playbackId, onCommentsLoaded]);

  const handleSubmit = useCallback(async (body: string, timestampSec?: number) => {
    if (!identity) return;
    setIsSubmitting(true);
    try {
      const newComment = await api<Comment>(`/v1/playback/${playbackId}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          authorName: identity.name,
          authorEmail: identity.email,
          body,
          timestampSec,
        }),
      });
      const updated = [newComment, ...comments];
      setComments(updated);
      setTotal((t) => t + 1);
      setNewCommentId(newComment.id);
      setTimeout(() => setNewCommentId(null), 2000);
      onCommentsLoaded(updated);
      onCommentAdded?.(newComment);
    } finally {
      setIsSubmitting(false);
    }
  }, [playbackId, comments, identity, onCommentsLoaded, onCommentAdded]);

  // Expose addComment for external callers (reactions)
  const addExternalComment = useCallback((comment: Comment) => {
    const updated = [comment, ...comments];
    setComments(updated);
    setTotal((t) => t + 1);
    setNewCommentId(comment.id);
    setTimeout(() => setNewCommentId(null), 2000);
    onCommentsLoaded(updated);
  }, [comments, onCommentsLoaded]);

  // Make addExternalComment accessible via a prop callback
  useEffect(() => {
    if (onCommentAdded) {
      // Store the ref so WatchPage can call it
      (onCommentAdded as any).__addExternal = addExternalComment;
    }
  }, [onCommentAdded, addExternalComment]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2.5 mb-5">
        <h2 className={`text-sm font-semibold tracking-tight ${dark ? 'text-zinc-200' : 'text-zinc-800'}`}>
          {labels.comments}
        </h2>
        {total > 0 && (
          <span
            className="text-[11px] font-medium px-2 py-0.5 rounded-full"
            style={{ backgroundColor: accentColor + '15', color: accentColor }}
          >
            {total}
          </span>
        )}
      </div>

      {/* Form */}
      <CommentForm
        onSubmit={handleSubmit}
        videoRef={videoRef}
        dark={dark}
        accentColor={accentColor}
        isSubmitting={isSubmitting}
        identity={identity}
        onRequestIdentity={onRequestIdentity}
        onClearIdentity={onClearIdentity}
        labels={labels}
      />

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div
            className="w-4 h-4 rounded-full border-2 animate-spin"
            style={{ borderColor: accentColor + '30', borderTopColor: accentColor }}
          />
        </div>
      ) : comments.length > 0 ? (
        <div className="mt-4">
          <CommentList
            comments={comments}
            onSeek={onSeek}
            dark={dark}
            accentColor={accentColor}
            newCommentId={newCommentId}
          />
        </div>
      ) : (
        <div className={`text-center py-12 rounded-2xl mt-4 ${dark ? 'bg-zinc-900/30' : 'bg-zinc-50/80'}`}>
          <div className={`w-10 h-10 rounded-full mx-auto mb-3 flex items-center justify-center ${dark ? 'bg-zinc-800' : 'bg-zinc-100'}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={dark ? 'text-zinc-600' : 'text-zinc-400'}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className={`text-sm ${dark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            {labels.noComments}
          </p>
        </div>
      )}
    </div>
  );
}
