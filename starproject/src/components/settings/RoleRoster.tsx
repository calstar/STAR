"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { EMAIL_RE } from "@/lib/email-roster";

/**
 * A list of emails holding a role (admins, PVPs), with Remove buttons and an
 * add box. The add/remove server actions are passed in; both enforce the same
 * rules server-side, including never removing the last member.
 */
export function RoleRoster({
  members,
  noun,
  add,
  remove,
  placeholder = "name@berkeley.edu",
}: {
  members: { email: string }[];
  /** "admin", "PVP": used in labels and messages. */
  noun: string;
  add: (email: string) => Promise<void>;
  remove: (email: string) => Promise<void>;
  placeholder?: string;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // Guard against locking everyone out: the sole remaining member can't be removed.
  const onlyOne = members.length === 1;

  const onAdd = async () => {
    const clean = email.trim().toLowerCase();
    if (!EMAIL_RE.test(clean)) return setError("Enter a valid email");
    if (members.some((a) => a.email === clean)) return setError(`Already a${/^[aeiou]/i.test(noun) ? "n" : ""} ${noun}`);
    setError(null);
    try {
      await add(clean);
      setEmail("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Couldn't add that ${noun}`);
    }
  };

  const onRemove = async (target: string) => {
    setError(null);
    try {
      await remove(target);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Couldn't remove that ${noun}`);
    }
  };

  return (
    <div>
      <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 rounded border border-neutral-200 dark:border-neutral-800">
        {members.map((a) => (
          <li key={a.email} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
            <span className="truncate">{a.email}</span>
            <button
              onClick={() => onRemove(a.email)}
              disabled={onlyOne}
              title={onlyOne ? `Can't remove the last ${noun}` : undefined}
              className="min-h-11 sm:min-h-0 shrink-0 rounded px-3 sm:px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:text-neutral-400 disabled:hover:bg-transparent"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
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
              void onAdd();
            }
          }}
          placeholder={placeholder}
          aria-label={`New ${noun} email`}
          className="min-h-11 sm:min-h-0 w-full sm:w-auto sm:min-w-56 sm:flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm"
        />
        <button
          onClick={() => void onAdd()}
          className="min-h-11 sm:min-h-0 w-full sm:w-auto rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Add {noun}
        </button>
      </div>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
