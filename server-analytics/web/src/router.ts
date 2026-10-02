import { useEffect, useState } from "react";

// Three routes do not justify a router library: pushState plus one event.
export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
}

/** Click handler for <a href> that stays in the SPA unless modified. */
export function linkClick(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(e.currentTarget.getAttribute("href")!);
}
