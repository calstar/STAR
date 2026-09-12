/**
 * This library feeds three apps through a path alias, and until now had nowhere to run its
 * own tests: no app's vitest `include` reaches `lib/stardesign-ui/src`, so a test file
 * placed here was executed by nobody. Hence a config of its own.
 *
 * jsdom, not the default `node` environment, because the bugs this exists to catch are all
 * in React wiring — a ref's initial value, a listener set, a timer, an effect. The pure
 * decisions already have coverage in checkoutPolicy.test.ts and it was not enough.
 *
 * Mirrors daq-server/diablo_server/frontend/vitest.config.ts, which is the working
 * precedent for this stack in this repo.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // A deployed origin, not jsdom's default localhost: the hook relaxes its
    // whole model on a developer's machine (`isLocalHost`), and the suite
    // pins the deployed one. The local mode has tests that opt in by option.
    environmentOptions: { jsdom: { url: 'https://pid-designer.starberkeley.org/' } },
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
  },
});
