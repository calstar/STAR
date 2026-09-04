import Image from "next/image";
import Link from "next/link";

import { HeaderNav } from "@/components/HeaderNav";
import { UserMenu } from "@/components/UserMenu";
import { isAdmin } from "@/lib/admins";
import { displayNameOf } from "@/lib/names";
import { getCurrentDbUser } from "@/lib/user";

// Rendered in the root layout. Calling getCurrentDbUser here also guarantees the
// viewer is upserted into the DB on any page they visit.
export async function AppHeader() {
  const user = await getCurrentDbUser();

  return (
    <header className="relative border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mx-auto flex max-w-[88rem] items-center justify-between px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <Link href="/" className="flex items-center gap-2 leading-none">
            {/* Blue wordmark in light mode, white wordmark in dark mode. */}
            <Image
              src="/star-blue.png"
              alt="STAR"
              width={5016}
              height={1772}
              priority
              unoptimized
              className="h-8 w-auto sm:h-10 dark:hidden"
            />
            <Image
              src="/star-wordmark.png"
              alt="STAR"
              width={5016}
              height={1772}
              priority
              unoptimized
              className="hidden h-8 w-auto sm:h-10 dark:block"
            />
            <span className="hidden text-2xl font-semibold leading-none tracking-tight text-neutral-900 min-[420px]:inline dark:text-neutral-100">
              Project
            </span>
          </Link>
          <HeaderNav />
        </div>
        <UserMenu
          name={displayNameOf(user)}
          email={user.email}
          isAdmin={await isAdmin(user.email)}
        />
      </div>
    </header>
  );
}
