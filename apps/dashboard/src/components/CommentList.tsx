import type { Comment } from '../lib/types.js';
import { CommentItem } from './CommentItem.js';

interface CommentListProps {
  comments: Comment[];
  onSeek: (time: number) => void;
  dark: boolean;
  accentColor: string;
  newCommentId?: string | null;
}

export function CommentList({ comments, onSeek, dark, accentColor, newCommentId }: CommentListProps) {
  return (
    <div className="max-h-[520px] overflow-y-auto -mx-1 px-1">
      {comments.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          onSeek={onSeek}
          dark={dark}
          accentColor={accentColor}
          isNew={comment.id === newCommentId}
        />
      ))}
    </div>
  );
}
