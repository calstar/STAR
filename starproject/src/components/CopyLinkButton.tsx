"use client";

import { useState } from "react";

/** Copies a shareable deep link to the clipboard. The link is the *current* page
 * URL with `?<param>=<value>` added (`?task=<id>` by default), so it preserves
 * where you are (a subteam page, a given view, …); visiting it re-opens the modal. */
export function CopyLinkButton({ param = "task", value }: { param?: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set(param, value);
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard blocked (e.g. insecure context) — fall back to a prompt.
      window.prompt("Copy this link:", link);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex min-h-11 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 sm:min-h-0"
    >
      {copied ? "Copied!" : "🔗 Copy link"}
    </button>
  );
}
