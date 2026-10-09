"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createApiToken, revokeApiToken } from "@/lib/actions/apiTokens";
import type { ApiTokenView } from "@/lib/apiTokens";

// ISO date, not toLocaleDateString: the server and the browser must render the
// same string or React reports a hydration mismatch.
const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "never");

export function ApiTokens({ tokens }: { tokens: ApiTokenView[] }) {
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await createApiToken(name || "token");
      setFresh(token);
      setCopied(false);
      setName("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create a token");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await revokeApiToken(id);
      if (r.error) setError(r.error);
      else router.refresh();
    } catch {
      setError("Couldn't revoke that token");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const live = tokens.filter((t) => !t.revokedAt);
  const revoked = tokens.filter((t) => t.revokedAt);

  return (
    <div>
      {fresh && (
        <div className="mb-3 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm">
          <p className="font-medium">Copy this token now — it won&apos;t be shown again.</p>
          <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
            <code className="break-all rounded bg-white dark:bg-neutral-900 px-2 py-1 text-xs">{fresh}</code>
            <button
              onClick={copy}
              className="min-h-11 sm:min-h-0 shrink-0 rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1 text-xs"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {live.length > 0 ? (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 rounded border border-neutral-200 dark:border-neutral-800">
          {live.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <div className="min-w-0">
                <div className="truncate">
                  <span className="font-medium">{t.name}</span>{" "}
                  <code className="text-xs text-neutral-500">{t.prefix}…</code>
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  created {when(t.createdAt)} · last used {when(t.lastUsedAt)}
                </div>
              </div>
              <button
                onClick={() => revoke(t.id)}
                disabled={busy}
                className="min-h-11 sm:min-h-0 shrink-0 rounded px-3 sm:px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-60 dark:hover:bg-red-950/40"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No active tokens.</p>
      )}

      <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
          }}
          maxLength={60}
          placeholder="What is this token for? (e.g. laptop Claude Code)"
          aria-label="New token name"
          className="min-h-11 sm:min-h-0 w-full sm:flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm"
        />
        <button
          onClick={create}
          disabled={busy}
          className="min-h-11 sm:min-h-0 w-full sm:w-auto rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          New token
        </button>
      </div>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}

      {revoked.length > 0 && (
        <details className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          <summary className="cursor-pointer">{revoked.length} revoked</summary>
          <ul className="mt-1 space-y-0.5">
            {revoked.map((t) => (
              <li key={t.id}>
                {t.name} <code>{t.prefix}…</code> · revoked {when(t.revokedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
