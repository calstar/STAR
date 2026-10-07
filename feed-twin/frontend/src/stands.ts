/**
 * Stands as shared documents: the client half of backend/routers/stands.py.
 *
 * The store is pid-designer's (lib/stardesign + lib/stardesign-ui): an owner,
 * a share list, a checkout, microversions and named releases. A stand is the
 * cockpit's configuration -- which drawing and engine, every setting, the
 * hookup, where the knobs sit -- not its running state, which stays in the
 * session.
 */

import { createDesignApi } from '@stardesign-ui';

export interface StandPayload {
  diagram: string;
  engine: string;
  fluid_set: string;
  machine: string;
  /** Configuration-tab settings, keyed as the backend's tunables name them. */
  setup: Record<string, number | boolean>;
  /** Valve pins and regulator knobs (`{valves, knobs}`). */
  hookup: Record<string, unknown>;
  /** Where the knobs sit: `{knobs: {id: psig}}`. */
  operating_point: Record<string, unknown>;
  notes: string;
}

export const EMPTY_STAND: StandPayload = {
  diagram: '',
  engine: '',
  fluid_set: 'hotfire',
  machine: 'diablo',
  setup: {},
  hookup: {},
  operating_point: {},
  notes: '',
};

export const standApi = createDesignApi<StandPayload>({
  base: '/api/twin/stands',
  usersPath: '/api/twin/users',
  codec: {
    toBody: (payload) => ({ ...payload }),
    fromBody: (body) => ({ ...EMPTY_STAND, ...(body as Partial<StandPayload>) }),
    empty: () => ({ ...EMPTY_STAND }),
  },
});
