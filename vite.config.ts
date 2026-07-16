import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env['AGENTCONTEXT_API_URL'] ?? 'http://127.0.0.1:3030';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/health': apiTarget,
      '/tools': apiTarget,
      '/tool-drafts': apiTarget,
      '/runs': apiTarget,
      '/agents': apiTarget,
      '/agent-sessions': apiTarget,
      '/agent-drafts': apiTarget,
      '/harnesses': apiTarget,
      '/harness-drafts': apiTarget,
      '/harness-runs': apiTarget,
      '/skills': apiTarget,
      '/skill-drafts': apiTarget,
      '/personas': apiTarget,
      '/scenarios': apiTarget,
      '/scenario-runs': apiTarget,
      '/evaluations': apiTarget,
      '/wiki': apiTarget,
      '/wikis': apiTarget,
      '/memory': apiTarget,
      '/operations': apiTarget,
      '/data-sources': apiTarget,
      '/search-providers': apiTarget,
      '/web-searches': apiTarget,
    },
  },
  build: { outDir: 'dist/ui', emptyOutDir: true },
});
