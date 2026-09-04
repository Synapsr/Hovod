import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type { Comment, CommentsResponse } from '../lib/types.js';
import type { UserIdentity } from './IdentityModal.js';
import { CommentForm } from './CommentForm.js';
import { CommentList } from './CommentList.js';
import { useT } from '../lib/i18n/index.js';

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
  const { t } = useT();
  const queryClient = useQueryClient();
  const [newCommentId, setNewCommentId] = useState<string | null>(null);

  const queryKey = ['comments', playbackId];

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: () => api<CommentsResponse>(`/v1/playback/${playbackId}/comments?limit=200`),
  });

  const comments = data?.comments;
  useEffect(() => {
    if (comments) onCommentsLoaded(comments);
  }, [comments, onCommentsLoaded]);

  const postComment = useMutation({
    mutationFn: (vars: { body: string; timestampSec?: number }) => {
      if (!identity) throw new Error(t.common.somethingWentWrong);
      return api<Comment>(`/v1/playback/${playbackId}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          authorName: identity.name,
          authorEmail: identity.email,
          body: vars.body,
          timestampSec: vars.timestampSec,
        }),
      });
    },
    onSuccess: (newComment) => {
      queryClient.setQueryData<CommentsResponse>(queryKey, (prev) => ({
        comments: [newComment, ...(prev?.comments ?? [])],
        total: (prev?.total ?? 0) + 1,
      }));
      setNewCommentId(newComment.id);
      setTimeout(() => setNewCommentId(null), 2000);
      onCommentAdded?.(newComment);
    },
  });

  /** Rejects on failure so the form can keep the draft and offer a retry. */
  const handleSubmit = useCallback(async (body: string, timestampSec?: number) => {
    await postComment.mutateAsync({ body, timestampSec });
  }, [postComment]);

  const total = data?.total ?? 0;

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
        isSubmitting={postComment.isPending}
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
      ) : isError ? (
        /* A failed load is not an empty discussion — say so and offer a retry. */
        <div className={`text-center py-12 rounded-2xl mt-4 ${dark ? 'bg-zinc-900/30' : 'bg-zinc-50/80'}`} role="alert">
          <p className={`text-sm ${dark ? 'text-zinc-300' : 'text-zinc-600'}`}>{t.watch.commentsFailed}</p>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className={`mt-3 h-8 px-3 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 ${
              dark ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700' : 'bg-zinc-200 text-zinc-700 hover:bg-zinc-300'
            }`}
          >
            {isFetching ? t.common.loading : t.common.retry}
          </button>
        </div>
      ) : comments && comments.length > 0 ? (
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
