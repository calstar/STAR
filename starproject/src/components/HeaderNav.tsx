"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const LINKS = [
  { href: "/projects", label: "Projects" },
  { href: "/tasks", label: "Tasks" },
  { href: "/subteams", label: "Subteams" },
  { href: "/activity", label: "Activity" },
];

// One link, styled per variant: mobile panel rows get a 44px touch target and
// an active background; desktop tabs keep the 2px underline (every tab carries
// a transparent border so switching tabs never shifts the layout).
function NavItem({
  href,
  label,
  active,
  mobile,
  onClick,
}: {
  href: string;
  label: string;
  active: boolean;
  mobile?: boolean;
  onClick?: () => void;
}) {
  const className = mobile
    ? `flex min-h-11 items-center rounded-md px-2 text-base ${
        active
          ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      }`
    : `border-y-2 border-transparent ${
        active
          ? "border-b-neutral-900 text-neutral-900 dark:border-b-neutral-100 dark:text-neutral-100"
          : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
      }`;
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {label}
    </Link>
  );
}

// Inline tabs at `sm+`; below `sm` the tabs collapse into a hamburger toggle
// with a full-width panel anchored to the (relative) header in AppHeader.
export function HeaderNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close the mobile menu on navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on outside tap and Escape, and when the viewport grows past `sm`
  // (otherwise the panel would reappear open after rotating back).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const mql = window.matchMedia("(min-width: 640px)");
    const onMedia = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    mql.addEventListener("change", onMedia);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
      mql.removeEventListener("change", onMedia);
    };
  }, [open]);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav ref={ref} className="flex items-center text-sm">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="header-nav-panel"
        aria-label="Menu"
        className="flex h-11 w-11 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 sm:hidden dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-5 w-5"
          aria-hidden="true"
        >
          {open ? (
            <path
              fillRule="evenodd"
              d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
              clipRule="evenodd"
            />
          ) : (
            <path
              fillRule="evenodd"
              d="M2.75 5.25a.75.75 0 0 1 .75-.75h13a.75.75 0 0 1 0 1.5h-13a.75.75 0 0 1-.75-.75Zm0 4.75a.75.75 0 0 1 .75-.75h13a.75.75 0 0 1 0 1.5h-13a.75.75 0 0 1-.75-.75Zm0 4.75a.75.75 0 0 1 .75-.75h13a.75.75 0 0 1 0 1.5h-13a.75.75 0 0 1-.75-.75Z"
              clipRule="evenodd"
            />
          )}
        </svg>
      </button>
      {open && (
        <div
          id="header-nav-panel"
          className="absolute inset-x-0 top-full z-50 border-b border-neutral-200 bg-white p-2 shadow-lg sm:hidden dark:border-neutral-800 dark:bg-neutral-900"
        >
          {LINKS.map(({ href, label }) => (
            <NavItem
              key={href}
              href={href}
              label={label}
              active={isActive(href)}
              mobile
              onClick={() => setOpen(false)}
            />
          ))}
        </div>
      )}
      <div className="hidden items-center gap-4 sm:flex">
        {LINKS.map(({ href, label }) => (
          <NavItem key={href} href={href} label={label} active={isActive(href)} />
        ))}
      </div>
    </nav>
  );
}
