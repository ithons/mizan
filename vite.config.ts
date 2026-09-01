import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  server: {
    fs: {
      /**
       * The data directory is never servable, by any route, in any mode.
       *
       * In dev, vite-express mounts Vite's middleware at '/' AFTER the API routers, and
       * `localOriginGuard` is mounted on '/api' only, so nothing in this app's own middleware
       * chain sees a request for `/@fs/<abs path>`. Vite's `serveRawFsMiddleware` will serve any
       * path under `fs.allow`, which defaults to the workspace root and therefore includes
       * `.mizan/`. Vite's default `fs.deny` covers `.env`, `*.pem` and `.git`, and does not cover
       * this: `.mizan/mizan.db` is the whole ledger and `.mizan/credentials.json` is the encrypted
       * credential envelope.
       *
       * The loopback bind in `server/src/index.ts` is what stops a peer on the network reaching
       * this at all, and that is the real control. This is the second half of the pair: defence
       * that does not depend on the bind being right, in the one place where being wrong hands
       * over the entire database in a single request.
       */
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.mizan/**', '**/.mizan-*/**'],
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
});
