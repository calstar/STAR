/**
 * Whether the editor is read-only, available to every input without threading a
 * prop through every panel between the bar and the leaf.
 *
 * A design is editable only while you hold its checkout. Rather than each app
 * passing `readOnly` down through its whole component tree, the bar publishes it
 * once here and the shared inputs consult it.
 *
 * Scope note: this disables *inputs*, not actions. Running a simulation or
 * opening history while read-only is fine -- neither changes the design -- so
 * those buttons deliberately do not consult this.
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
