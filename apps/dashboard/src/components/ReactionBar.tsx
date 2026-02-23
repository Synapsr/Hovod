import { useState } from 'react';

interface ReactionBarProps {
  onReact: (emoji: string) => void;
  dark: boolean;
  accentColor: string;
}

const EMOJIS = [
  { key: 'fire', char: '\u{1F525}' },
  { key: 'heart', char: '\u{2764}\u{FE0F}' },
  { key: 'laugh', char: '\u{1F602}' },
  { key: 'clap', char: '\u{1F44F}' },
  { key: 'mindblown', char: '\u{1F92F}' },
  { key: 'sad', char: '\u{1F622}' },
];

export function ReactionBar({ onReact, dark, accentColor }: ReactionBarProps) {
  const [animating, setAnimating] = useState<string | null>(null);

  const handleClick = (emoji: typeof EMOJIS[number]) => {
    setAnimating(emoji.key);
    setTimeout(() => setAnimating(null), 500);
    onReact(emoji.char);
  };

  return (
    <div className="flex items-center justify-center gap-1">
      {EMOJIS.map((emoji) => {
        const isAnimating = animating === emoji.key;
        return (
          <button
            key={emoji.key}
            onClick={() => handleClick(emoji)}
            className={`
              w-10 h-10 rounded-full flex items-center justify-center text-lg transition-all duration-200
              ${isAnimating ? 'scale-125' : 'hover:scale-110 active:scale-95'}
              ${dark ? 'hover:bg-zinc-800/80' : 'hover:bg-zinc-100'}
            `}
            style={isAnimating ? { backgroundColor: accentColor + '15' } : undefined}
          >
            <span className={isAnimating ? 'animate-bounce' : ''}>
              {emoji.char}
            </span>
          </button>
        );
      })}
    </div>
  );
}
