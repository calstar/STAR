import Image from "next/image";
import Link from "next/link";

import { UserMenu } from "@/components/UserMenu";
import { getCurrentDbUser } from "@/lib/user";

// Rendered in the root layout. Calling getCurrentDbUser here also guarantees the
// viewer is upserted into the DB on any page they visit.
export async function AppHeader() {
  const user = await getCurrentDbUser();

  const navLink =
    "text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100";

  return (
    <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-2">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 leading-none">
            {/* Blue wordmark in light mode, white wordmark in dark mode. */}
            <Image
              src="/star-blue.png"
              alt="STAR"
              width={5016}
              height={1772}
              priority
              unoptimized
              className="h-10 w-auto dark:hidden"
            />
            <Image
              src="/star-wordmark.png"
              alt="STAR"
              width={5016}
              height={1772}
              priority
              unoptimized
              className="hidden h-10 w-auto dark:block"
            />
            <span className="text-2xl font-semibold leading-none tracking-tight text-neutral-900 dark:text-neutral-100">
              Project
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/projects" className={navLink}>
              Projects
            </Link>
            <Link href="/tasks" className={navLink}>
              Tasks
            </Link>
            <Link href="/subteams" className={navLink}>
              Subteams
            </Link>
            <Link href="/activity" className={navLink}>
              Activity
            </Link>
          </nav>
        </div>
        <UserMenu name={user.name ?? user.email} email={user.email} />
      </div>
    </header>
  );
}
