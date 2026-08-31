"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/projects", label: "Projects" },
  { href: "/tasks", label: "Tasks" },
  { href: "/subteams", label: "Subteams" },
  { href: "/activity", label: "Activity" },
];

// The active tab is underlined. Every tab carries a 2px bottom border (only the
// active one is colored) so switching tabs never shifts the layout.
export function HeaderNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-4 text-sm">
      {LINKS.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`border-y-2 border-transparent ${
              active
                ? "border-b-neutral-900 text-neutral-900 dark:border-b-neutral-100 dark:text-neutral-100"
                : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
