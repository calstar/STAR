import type { ReactElement } from 'react';
import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ROUTES, VIEWS } from './App';

describe('the views are routes', () => {
  it('routes every view the header links to', () => {
    for (const v of VIEWS) {
      const m = matchRoutes(ROUTES, v.path);
      expect(m?.[m.length - 1].route.path, v.path).toBe(v.path);
    }
  });

  it('sends an address that is no view to the Console', () => {
    // /nonsense drew the header over an empty page, and React Router warned
    // "No routes matched" on every tick.
    for (const path of ['/nonsense', '/plots/extra', '/Console']) {
      const m = matchRoutes(ROUTES, path);
      expect(m, path).not.toBeNull();
      const route = m![m!.length - 1].route;
      expect(route.path).toBe('*');
      expect((route.element as ReactElement<{ to: string; replace: boolean }>).props).toMatchObject({ to: '/', replace: true });
    }
  });
});
