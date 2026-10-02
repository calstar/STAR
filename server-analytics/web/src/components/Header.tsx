import { useEffect, useRef, useState } from "react";

import { get } from "../api";
import { linkClick } from "../router";
import { setTheme, useDark } from "../theme";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/logs", label: "Logs" },
];

// Mirrors starproject/src/components/AppHeader.tsx and HeaderNav.tsx: the logo
// swap, the app name beside it, underline tabs, and a pill user menu.
export function Header({ path }: { path: string }) {
  const [email, setEmail] = useState<string>("");
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const dark = useDark();

  useEffect(() => {
    get<{ email: string }>("/api/me").then((m) => setEmail(m.email), () => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => menu.current && !menu.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const active = (href: string) => (href === "/" ? path === "/" || path.startsWith("/hosts/") : path.startsWith(href));

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mx-auto flex max-w-[88rem] items-center justify-between px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <a href="/" onClick={linkClick} className="flex items-center gap-2 leading-none">
            <img src="/star-blue.png" alt="STAR" className="h-8 w-auto sm:h-10 dark:hidden" />
            <img src="/star-wordmark.png" alt="STAR" className="hidden h-8 w-auto sm:h-10 dark:block" />
            <span className="hidden text-2xl font-semibold leading-none tracking-tight text-neutral-900 min-[420px]:inline dark:text-neutral-100">
              Analytics
            </span>
          </a>
          <nav className="flex items-center gap-4 text-sm">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={linkClick}
                aria-current={active(l.href) ? "page" : undefined}
                className={`border-y-2 border-transparent py-1 ${
                  active(l.href)
                    ? "border-b-neutral-900 text-neutral-900 dark:border-b-neutral-100 dark:text-neutral-100"
                    : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
                }`}
              >
                {l.label}
              </a>
            ))}
          </nav>
        </div>
        <div ref={menu} className="relative">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex min-h-11 items-center gap-2 rounded-full border border-neutral-200 py-1 pl-1 pr-3 text-sm hover:bg-neutral-50 sm:min-h-0 dark:border-neutral-800 dark:hover:bg-neutral-800"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
              {(email[0] ?? "?").toUpperCase()}
            </span>
            <span className="hidden max-w-[12rem] truncate sm:inline">{email || "…"}</span>
          </button>
          {open && (
            <div className="absolute right-0 z-50 mt-1 w-48 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
              <button
                onClick={() => setTheme(!dark)}
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {dark ? "Light mode" : "Dark mode"}
              </button>
              <a
                href="https://auth.starberkeley.org/logout"
                className="block rounded px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                Sign out
              </a>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
