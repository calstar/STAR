import Image from "next/image";
import Link from "next/link";

import { HeaderNav } from "@/components/HeaderNav";
import { UserMenu } from "@/components/UserMenu";
import { isAdmin } from "@/lib/admins";
import { getCurrentDbUser } from "@/lib/user";

// Rendered in the root layout. Calling getCurrentDbUser here also guarantees the
// viewer is upserted into the DB on any page they visit.
export async function AppHeader() {
  const user = await getCurrentDbUser();

  return (
    <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mx-auto flex max-w-[88rem] items-center justify-between px-6 py-2">
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
          <HeaderNav />
        </div>
        <UserMenu
          name={user.name ?? user.email}
          email={user.email}
          isAdmin={isAdmin(user.email)}
        />
      </div>
    </header>
  );
}
