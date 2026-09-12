import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The backend port, matching dev.sh's ENGINE_DESIGN_API_PORT.
//
// dev.sh offers that variable so a developer can "dodge something already on the
// port" -- and until this read it, taking that offer moved the backend and left
// the UI proxying to 8000, where it either found nothing or, worse, found some
// *other* app answering and reported its 404s as ours.
const API_PORT = process.env.ENGINE_DESIGN_API_PORT || '8000'

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
  define: {
    // So the "backend not connected" message can name the port actually in use
    // instead of telling the user to check one nobody is listening on.
    __API_PORT__: JSON.stringify(API_PORT),
  },
  server: {
    proxy: {
      '/api': {
        // IPv4-explicit: "localhost" can resolve to IPv6 ::1 on CI runners while
        // the backend (uvicorn) listens on 127.0.0.1, so the dev proxy would
        // fail to reach it. Only affects `vite dev` (prod serves a static build).
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ['**/tsconfig.json', '**/tsconfig.*.json'],
    },
  },
})
