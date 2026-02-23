import { useState } from 'react';
import { api } from '../lib/api.js';

export function ImportForm({ onRefresh }: { onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleImport = async () => {
    if (!url) return;
    setLoading(true);
    setError('');
    try {
      const t = title || url.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'Imported video';
      const { id } = await api<{ id: string }>('/v1/assets', {
        method: 'POST',
        body: JSON.stringify({ title: t }),
      });
      await api(`/v1/assets/${id}/import`, {
        method: 'POST',
        body: JSON.stringify({ sourceUrl: url }),
      });
      await api(`/v1/assets/${id}/process`, { method: 'POST' });
      setUrl('');
      setTitle('');
      setOpen(false);
      onRefresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors mt-3"
      >
        Or import from URL
      </button>
    );
  }

  return (
    <div className="mt-3 p-4 border border-zinc-800 rounded-xl bg-zinc-900/80">
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Video title"
          className="h-9 px-3 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500 transition-colors sm:w-40"
        />
        <input
          placeholder="https://example.com/video.mp4"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Video URL"
          className="h-9 flex-1 px-3 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500 transition-colors"
        />
        <div className="flex gap-2">
          <button
            onClick={handleImport}
            disabled={!url || loading}
            className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? 'Importing...' : 'Import'}
          </button>
          <button
            onClick={() => { setOpen(false); setError(''); }}
            className="h-9 px-3 text-sm rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
