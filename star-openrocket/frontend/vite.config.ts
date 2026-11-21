import { fileURLToPath, URL } from 'node:url'

import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Shared design-tool UI, compiled from source by this app's own Vite --
      // which is why the apps can sit on different Vite majors.
      '@stardesign-ui': fileURLToPath(new URL('../../lib/stardesign-ui/src', import.meta.url)),
      // The OpenRocket tab: openrocket-web's <OpenRocketWorkbench/>, compiled from
      // source the same way (the Dockerfile copies it to the same relative place).
      // It brings its own icons and font through Vite imports, so nothing has to be
      // copied into public/; it uses no Tailwind classes, so no @source either.
      '@openrocket-web': fileURLToPath(new URL('../../openrocket-web/frontend/src', import.meta.url)),
      // The shared source sits outside this project, so Node resolution from it
      // walks up past any node_modules and cannot find React. Pin both to this
      // app's copies -- which also guarantees one React instance, not two.
      react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
    },
  },
  server: {
    port: 5175,
    fs: {
      // The dev server serves files outside this project only when they are in the
      // module graph; the workbench's font is reached from its CSS url(), which is
      // not, so it 403s without this. The default root is kept alongside.
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        fileURLToPath(new URL('../../openrocket-web/frontend/src', import.meta.url)),
      ],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8002',
        changeOrigin: true,
      },
    },
  },
})
