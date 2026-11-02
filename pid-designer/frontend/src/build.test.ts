// How the production bundle is cut. One 789 kB chunk tripped Vite's 500 kB
// warning on every build; the packages' script now goes in a chunk of its own
// (vite.config.ts). What is pinned here is the rule that does it -- the build
// itself is too slow for this suite -- and the half of it that is easy to get
// wrong: a package's stylesheet must stay with the app's CSS, or React Flow's
// rules are linked ahead of index.css in production and the cascade flips.
import { describe, expect, it } from 'vitest';
import config, { VENDOR_SCRIPT } from '../vite.config';

const root = '/home/user/STAR/pid-designer/frontend';

describe('the production bundle', () => {
  it('cuts the packages\' script into a vendor chunk', () => {
    const groups = (config as { build?: { rolldownOptions?: { output?: { codeSplitting?: { groups?: { name: string; test: unknown }[] } } } } })
      .build?.rolldownOptions?.output?.codeSplitting?.groups ?? [];
    expect(groups).toContainEqual({ name: 'vendor', test: VENDOR_SCRIPT });
    for (const id of [
      `${root}/node_modules/react-dom/cjs/react-dom-client.production.js`,
      `${root}/node_modules/@xyflow/react/dist/esm/index.js`,
      `${root}/node_modules/d3-zoom/src/zoom.js`,
      `${root}/node_modules/html-to-image/es/index.js`,
      'C:\\star\\pid-designer\\frontend\\node_modules\\react\\index.js',
    ]) expect(VENDOR_SCRIPT.test(id), id).toBe(true);
  });

  it('leaves the app, the shared UI and every stylesheet out of it', () => {
    for (const id of [
      `${root}/src/components/pid/PIDDesigner.tsx`,
      `${root}/src/index.css`,
      '/home/user/STAR/lib/stardesign-ui/src/api.ts',
      `${root}/node_modules/@xyflow/react/dist/style.css`,
      `${root}/node_modules/@xyflow/react/dist/style.css?direct`,
    ]) expect(VENDOR_SCRIPT.test(id), id).toBe(false);
  });
});
