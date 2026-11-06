import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** A module the vendor chunk takes: a package's script, never its CSS. */
export const VENDOR_SCRIPT = /[\\/]node_modules[\\/].*\.[cm]?[jt]sx?(\?.*)?$/

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
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // The packages' code -- React, React Flow and its d3 pieces, nearly
          // half of it -- in a chunk of its own. One 789 kB chunk tripped Vite's
          // 500 kB warning on every build; split, each half is under it, and the
          // packages, which change only with package.json, stay cached across
          // a deploy of the drawing tool. Both load at startup, as before: no
          // lazy chunk an open tab could ask for after a deploy removed it.
          //
          // Script only. React Flow's stylesheet stays in the app's CSS, after
          // index.css, where the dev server puts it: split out, it was linked
          // first and every index.css rule on a .react-flow class of equal
          // specificity would have started winning in production alone.
          groups: [{ name: 'vendor', test: VENDOR_SCRIPT }],
        },
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        // Follows the same override dev.sh honours for the API itself, so a
        // second checkout can run its own pair of servers on other ports
        // rather than proxying into the first one's backend.
        target: `http://localhost:${process.env.PID_DESIGNER_API_PORT ?? 8001}`,
        changeOrigin: true,
      },
    },
  },
})
