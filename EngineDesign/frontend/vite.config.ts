import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Shared design-tool UI, compiled from source by this app's own Vite --
      // which is why the three apps can sit on different Vite majors.
      '@stardesign-ui': fileURLToPath(new URL('../../lib/stardesign-ui/src', import.meta.url)),
      // The shared source sits outside this project, so Node resolution from it
      // walks up past any node_modules and cannot find React. Pin both to this
      // app's copies -- which also guarantees one React instance, not two.
      react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        // IPv4-explicit: "localhost" can resolve to IPv6 ::1 on CI runners while
        // the backend (uvicorn) listens on 127.0.0.1, so the dev proxy would
        // fail to reach it. Only affects `vite dev` (prod serves a static build).
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ['**/tsconfig.json', '**/tsconfig.*.json'],
    },
  },
})
