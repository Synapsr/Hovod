import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Serve embed.html for /embed/* in the dev and preview servers (the API does the same in
 * standalone mode) so the lightweight embed entry is used everywhere, not only in production.
 */
function embedEntryPlugin(): Plugin {
  const rewrite = (server: { middlewares: { use: (fn: (req: any, _res: any, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/embed\/[^/?#]+(?:[?#].*)?$/.test(req.url)) {
        req.url = '/embed.html';
      }
      next();
    });
  };
  return {
    name: 'hovod-embed-entry',
    configureServer: rewrite,
    configurePreviewServer: rewrite,
  };
}

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react(), embedEntryPlugin()],
  envDir: '../../',
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        embed: resolve(root, 'embed.html'),
      },
      output: {
        manualChunks(id) {
          // Keep hls.js in its own chunk: loaded by the embed entry and the /watch route only
          if (id.includes('node_modules/hls.js/')) return 'hls';
        },
      },
    },
  },
});
