import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The P&ID is drawn by pid-designer's own canvas, compiled from source by
      // this app's Vite: the same symbols, router and fluid colours, so a
      // drawing looks here exactly as it does in the editor
      // (pid-designer/frontend/src/components/pid/DrawingView.tsx).
      '@pid': here('../../pid-designer/frontend/src/components/pid'),
      // Which imports the shared design-tool UI.
      '@stardesign-ui': here('../../lib/stardesign-ui/src'),
      // That source sits outside this project, so Node resolution from it walks
      // up to pid-designer's node_modules -- absent in CI and in the image --
      // or past every node_modules. Pin each package it imports to this app's
      // copy, which also guarantees one React and one React Flow, not two.
      react: here('./node_modules/react'),
      'react-dom': here('./node_modules/react-dom'),
      '@xyflow/react': here('./node_modules/@xyflow/react'),
    },
  },
  server: {
    port: 5177,
    proxy: {
      // The dev server proxies /api so the frontend uses same-origin paths in
      // dev and in prod alike. In prod Caddy does this (Phase 09); nothing in
      // the app code knows the difference.
      '/api': {
        // Follows the override dev.sh honours for the API itself, so a second
        // checkout can run its own pair of servers rather than proxying into
        // the first one's backend.
        target: `http://localhost:${process.env.FEED_TWIN_API_PORT ?? 8003}`,
        changeOrigin: true,
      },
    },
  },
})
