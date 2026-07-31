import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// PLAN.md §11.1: the ports are load-bearing, not cosmetic. EngineDesign/dev.sh
// force-kills whatever holds 8000, so sharing a port would let one app
// silently kill the other. This app owns 5273 (frontend) and 8100 (backend).
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
