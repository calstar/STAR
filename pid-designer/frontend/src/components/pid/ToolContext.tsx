import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * Which canvas tool is armed.
 *
 * `none` is the ordinary state: click selects, double-click configures, drag
 * connects. A tool changes what a click *does*, and only while it is armed.
 *
 * This exists because junction placement used to be a bare click on a line.
 * Every click put one in -- so a double-click, which is two clicks, inserted
 * two junctions and then opened a dialog for an edge that no longer existed,
 * and clicking around the drawing scattered them everywhere. A gesture that
 * destructive cannot be the same gesture as "look at this".
 */
export type Tool = 'none' | 'paint' | 'junction';

const ToolContext = createContext<{ tool: Tool; done: () => void }>({ tool: 'none', done: () => {} });

/**
 * `done` is how a one-shot tool puts itself down. The Junction tool used to
 * stay armed until Escape, so the click after placing one -- meant to select
 * something -- put in another. Placing one is the job; the tool disarms when
 * the job is done.
 */
export function ToolProvider({ tool, onDone, children }: { tool: Tool; onDone: () => void; children: ReactNode }) {
  return <ToolContext.Provider value={{ tool, done: onDone }}>{children}</ToolContext.Provider>;
}

export const useTool = () => useContext(ToolContext).tool;
export const useToolDone = () => useContext(ToolContext).done;
