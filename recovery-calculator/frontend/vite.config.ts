import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// PLAN.md §11.1: the ports are load-bearing, not cosmetic. EngineDesign/dev.sh
// force-kills whatever holds 8000, so sharing a port would let one app
// silently kill the other. This app owns 5273 (frontend) and 8100 (backend).
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
    port: 5273,
    strictPort: true, // fail loudly rather than drift onto 5274 and confuse dev.sh
    proxy: {
      '/api': {
        target: 'http://localhost:8100',
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ['**/tsconfig.json', '**/tsconfig.*.json'],
    },
  },
})
