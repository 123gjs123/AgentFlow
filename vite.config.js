import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  // Dev server: serve only the client and its deps. Never data/ (token, flows, runs, chats).
  server: {
    fs: {
      strict: true,
      allow: [path.join(ROOT, 'client'), path.join(ROOT, 'node_modules')],
      deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/data/**', '**/config.json'],
    },
  },
});
