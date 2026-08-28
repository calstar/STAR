import Link from "next/link";

import { getCurrentDbUser } from "@/lib/user";

// Rendered in the root layout. Calling getCurrentDbUser here also guarantees the
// viewer is upserted into the DB on any page they visit, so they appear in
// assignee pickers even before they create anything.
export async function AppHeader() {
  const user = await getCurrentDbUser();
  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight">
            STARProject
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="text-neutral-600 hover:text-neutral-900">
              Projects
            </Link>
            <Link href="/tasks" className="text-neutral-600 hover:text-neutral-900">
              Tasks
            </Link>
          </nav>
        </div>
        <span className="text-sm text-neutral-600">{user.name ?? user.email}</span>
      </div>
    </header>
  );
}
