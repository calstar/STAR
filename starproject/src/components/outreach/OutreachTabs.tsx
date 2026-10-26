"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/outreach", label: "Today" },
  { href: "/outreach/sponsors", label: "Sponsors" },
  { href: "/outreach/people", label: "People" },
  { href: "/outreach/lists", label: "Lists" },
  { href: "/outreach/compose", label: "Compose" },
  { href: "/outreach/campaigns", label: "Campaigns" },
  { href: "/outreach/templates", label: "Templates" },
  { href: "/outreach/import", label: "Import" },
];

export function OutreachTabs() {
  const path = usePathname();
  return (
    <nav className="-mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800">
      {TABS.map((t) => {
        const active = t.href === "/outreach" ? path === t.href : path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              active
                ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300"
                : "border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
