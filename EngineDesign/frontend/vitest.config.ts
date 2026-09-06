import { defineConfig } from 'vitest/config';

/**
 * Unit tests only, and only under src/.
 *
 * Without `include`, vitest's default glob also picks up `e2e/*.spec.ts` --
 * those are Playwright specs, they import `@playwright/test`, and vitest cannot
 * run them. The two suites are run by different commands on purpose:
 * `npm test` (here) and `npm run test:e2e` (playwright.config.ts).
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
  },
});
