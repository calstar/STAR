import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests only, and only under src/.
 *
 * Without `include`, vitest's default glob also picks up `e2e/*.spec.ts` --
 * those are Playwright specs, they import `@playwright/test`, and vitest cannot
 * run them. The two suites are run by different commands on purpose:
 * `npm test` (here) and `npm run test:e2e` (playwright.config.ts).
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The same source aliases as vite.config.ts, so a component that draws with
  // pid-designer's code (lx/hero/PidView) can be imported by a test.
  resolve: {
    alias: {
      '@stardesign-ui': here('../../lib/stardesign-ui/src'),
      '@pid': here('../../pid-designer/frontend/src/components/pid'),
      '@xyflow/react': here('./node_modules/@xyflow/react'),
      react: here('./node_modules/react'),
      'react-dom': here('./node_modules/react-dom'),
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
  },
});
