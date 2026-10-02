"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { requestCallinkLogin } from "@/lib/actions/finance";

const btn =
  "min-h-11 rounded border border-current/30 px-3 py-1.5 text-sm font-medium hover:bg-black/5 disabled:opacity-50 sm:min-h-0 dark:hover:bg-white/10";

/**
 * Asks callink-worker to sign in to CalLink, which sends the Duo push. While a
 * sign-in is under way the page refreshes itself so the banner follows along.
 */
export function CallinkLoginButton({ busy, label }: { busy: boolean; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [busy, router]);

  if (busy) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={btn}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await requestCallinkLogin();
            if ("error" in res) setError(res.error);
            router.refresh();
          })
        }
      >
        {pending ? "Asking…" : label}
      </button>
      {error && <span className="text-xs">{error}</span>}
    </span>
  );
}
