import Link from "next/link";

import { getCurrentDbUser } from "@/lib/user";

// Rendered in the root layout. Calling getCurrentDbUser here also guarantees the
// viewer is upserted into the DB on any page they visit, so they appear in
// assignee pickers even before they create anything.
export async function AppHeader() {
  const user = await getCurrentDbUser();
  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          STARProject
        </Link>
        <span className="text-sm text-neutral-600">{user.name ?? user.email}</span>
      </div>
    </header>
  );
}
