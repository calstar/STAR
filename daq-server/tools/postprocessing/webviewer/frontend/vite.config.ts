import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the FastAPI backend so the app is effectively
// same-origin. `npm run build` emits to dist/, which the backend serves in the
// single-process setup.
export default defineConfig({
  plugins: [react()],
  server: {
    // Ports chosen to avoid the onshape-viewer / diablo_server services in this
    // repo (which use 8000-8081, 3000, 2240, 5173-5176).
    port: 5273,
    proxy: {
      '/api': { target: 'http://localhost:8420', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
