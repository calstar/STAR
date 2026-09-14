import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5177,
    proxy: {
      // The dev server proxies /api so the frontend uses same-origin paths in
      // dev and in prod alike. In prod Caddy does this (Phase 09); nothing in
      // the app code knows the difference.
      '/api': {
        target: 'http://localhost:8003',
        changeOrigin: true,
      },
    },
  },
})
