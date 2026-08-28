import Link from "next/link";

import { UserMenu } from "@/components/UserMenu";
import { getCurrentDbUser } from "@/lib/user";

// Rendered in the root layout. Calling getCurrentDbUser here also guarantees the
// viewer is upserted into the DB on any page they visit, so they appear in
// assignee pickers even before they create anything.
export async function AppHeader() {
  const user = await getCurrentDbUser();
  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight">
            STARProject
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:text-neutral-100">
              Projects
            </Link>
            <Link href="/tasks" className="text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:text-neutral-100">
              Tasks
            </Link>
            <Link
              href="/subteams"
              className="text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:text-neutral-100"
            >
              Subteams
            </Link>
            <Link
              href="/activity"
              className="text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:text-neutral-100"
            >
              Activity
            </Link>
          </nav>
        </div>
        <UserMenu name={user.name ?? user.email} email={user.email} />
      </div>
    </header>
  );
}
