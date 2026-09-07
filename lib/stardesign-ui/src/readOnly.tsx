/**
 * Whether the editor is read-only, available to every input without threading a
 * prop through every panel between the bar and the leaf.
 *
 * A design is editable only while you hold its checkout. Rather than each app
 * passing `readOnly` down through its whole component tree, the bar publishes it
 * once here and the shared inputs consult it.
 *
 * Scope note: this disables *inputs*, not actions -- but "action" is decided per
 * app, by what the endpoint actually does, not by what the button is called.
 * Opening history or exporting a file is always safe. A "run" is not
 * automatically safe: EngineDesign's optimizer layers write their result back
 * into the live config (backend/routers/optimizer.py), so there the Run buttons
 * are gated along with the inputs. Check the route before leaving one live.
 */

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

const ReadOnlyContext = createContext(false);

export function ReadOnlyProvider({
  readOnly,
  children,
}: {
  readOnly: boolean;
  children: ReactNode;
}) {
  return <ReadOnlyContext.Provider value={readOnly}>{children}</ReadOnlyContext.Provider>;
}

/** True when the design is not checked out to you. */
export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

/**
 * `disabled` for an input, honouring both its own prop and the read-only mode.
 *
 * Every editable control should route through this, so adding one cannot
 * accidentally stay live when the design is checked out to somebody else.
 */
export function useDisabled(own?: boolean): boolean {
  return useContext(ReadOnlyContext) || !!own;
}
