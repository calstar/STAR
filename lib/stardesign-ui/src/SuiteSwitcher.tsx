import { Fragment, type MouseEvent } from 'react';
import { SUITE, siblingUrl, suiteUrlsFrom, type SuiteApp, type SuiteWhere } from './suite';

/**
 * The Hotbench header's left end, the same in every app: the wordmark, "a STAR
 * project" under it, and Engine | P&ID | Twin with the app you are in marked.
 * The other two are plain links to their own app (suite.ts says where).
 *
 * It paints only with the shared tokens (tokens.css), each with a fallback, so
 * an app that keeps a palette of its own (EngineDesign) needs nothing imported
 * to use it; the font is the host's, so it reads as each app's own type.
 */
export function SuiteSwitcher({
  app,
  onHome,
  className = '',
  where,
}: {
  /** The app this header belongs to. */
  app: SuiteApp;
  /** Clicking the current app's name: its home, in the app's own router. Without
   *  it the name is marked but not a link. */
  onHome?: () => void;
  className?: string;
  /** Where this app is served; `window.location` unless a test says otherwise. */
  where?: SuiteWhere;
}) {
  const here = where ?? (typeof window === 'undefined' ? null : window.location);
  const given = suiteUrlsFrom((import.meta as ImportMeta & { env?: Record<string, unknown> }).env);
  const home = (e: MouseEvent) => {
    // A modified click still opens the app's home in a new tab.
    if (!onHome || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onHome();
  };
  return (
    <nav
      aria-label="Hotbench apps"
      className={`flex shrink-0 select-none flex-col whitespace-nowrap leading-none ${className}`}
    >
      <span className="flex items-baseline gap-4">
        <span
          className="text-[15px] font-bold uppercase tracking-[0.34em] text-[var(--color-text-primary,#ededed)]"
          title="Hotbench: draw the stand, design the engine, run the stand. A STAR project."
        >
          Hotbench
        </span>
        <span className="flex items-baseline gap-2.5 text-[12px] font-medium uppercase tracking-[0.16em]">
          {SUITE.map((e, i) => {
            const hint = `${e.name}: ${e.does}`;
            const sep = i > 0 && (
              <span aria-hidden className="h-2.5 w-px self-center bg-[var(--color-border,#2e2e2e)]" />
            );
            if (e.app === app) {
              const mark =
                'text-[var(--color-text-primary,#ededed)] underline decoration-1 underline-offset-[5px]';
              return (
                <Fragment key={e.app}>
                  {sep}
                  {onHome ? (
                    <a href="/" aria-current="page" title={hint} onClick={home} className={mark}>
                      {e.label}
                    </a>
                  ) : (
                    <span aria-current="page" title={hint} className={mark}>
                      {e.label}
                    </span>
                  )}
                </Fragment>
              );
            }
            const url = here ? siblingUrl(e.app, here, given) : null;
            return (
              <Fragment key={e.app}>
                {sep}
                {url ? (
                  <a
                    href={url}
                    title={hint}
                    className="text-[var(--color-text-muted,#7a7a7a)] transition-colors hover:text-[var(--color-text-secondary,#a3a3a3)]"
                  >
                    {e.label}
                  </a>
                ) : (
                  <span
                    title={`${hint}. It is not served next to this copy.`}
                    className="text-[var(--color-text-muted,#7a7a7a)] opacity-60"
                  >
                    {e.label}
                  </span>
                )}
              </Fragment>
            );
          })}
        </span>
      </span>
      <span className="mt-1 text-[9px] tracking-[0.08em] text-[var(--color-text-muted,#7a7a7a)]">a STAR project</span>
    </nav>
  );
}
