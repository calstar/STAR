"use client";

import { useState } from "react";

import { BTN } from "./ui";

/** Copies `text` (or what `getText` returns at click time) to the clipboard. */
export function CopyButton({
  text,
  getText,
  label,
  className = BTN,
  disabled,
}: {
  text?: string;
  getText?: () => string;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const value = getText ? getText() : (text ?? "");
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      window.prompt("Copy this:", value);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" onClick={copy} className={className} disabled={disabled}>
      {copied ? "Copied!" : label}
    </button>
  );
}
