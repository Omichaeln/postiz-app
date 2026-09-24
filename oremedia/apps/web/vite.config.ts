import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Two build targets (spec 21.1): the app (`index.html`) and the external reviewer portal (`review-portal.html`),
 * which is served from a separate origin in production (REVIEW_PORTAL_ORIGIN) so reviewer links never share the
 * app's cookies. In development `/trpc` is proxied to the API so the session cookie stays first-party.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env['WEB_PORT'] ?? 5173),
    proxy: {
      '/trpc': { target: process.env['OREMEDIA_API_URL'] ?? 'http://127.0.0.1:3001', changeOrigin: false },
    },
  },
  build: {
    rollupOptions: {
      input: { main: here('./index.html'), 'review-portal': here('./review-portal.html') },
    },
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
