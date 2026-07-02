import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/health': 'http://127.0.0.1:3030',
      '/tools': 'http://127.0.0.1:3030',
      '/tool-drafts': 'http://127.0.0.1:3030',
    },
  },
  build: { outDir: 'dist/ui', emptyOutDir: true },
});
