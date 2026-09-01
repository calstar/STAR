"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { addAdmin, removeAdmin } from "@/lib/actions/admins";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AdminConfig({
  admins,
}: {
  admins: { email: string; removable: boolean }[];
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const add = async () => {
    const clean = email.trim().toLowerCase();
    if (!EMAIL_RE.test(clean)) return setError("Enter a valid email");
    if (admins.some((a) => a.email === clean)) return setError("Already an admin");
    setError(null);
    await addAdmin(clean);
    setEmail("");
    router.refresh();
  };

  const remove = async (e: string) => {
    await removeAdmin(e);
    router.refresh();
  };

  return (
    <div>
      <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 rounded border border-neutral-200 dark:border-neutral-800">
        {admins.map((a) => (
          <li
            key={a.email}
            className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
          >
            <span className="truncate">{a.email}</span>
            {a.removable ? (
              <button
                onClick={() => remove(a.email)}
                className="shrink-0 rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                Remove
              </button>
            ) : (
              <span className="shrink-0 text-xs text-neutral-400">built-in</span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="name@berkeley.edu"
          aria-label="New admin email"
          className="min-w-56 flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm"
        />
        <button
          onClick={add}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Add admin
        </button>
      </div>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
