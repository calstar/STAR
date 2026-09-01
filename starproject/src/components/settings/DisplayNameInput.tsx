"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setDisplayName } from "@/lib/actions/settings";

export function DisplayNameInput({
  value,
  placeholder,
}: {
  value: string;
  placeholder: string;
}) {
  const [name, setName] = useState(value);
  const router = useRouter();

  const save = async () => {
    if (name === value) return; // nothing changed
    await setDisplayName(name);
    router.refresh(); // pull the new name into the header and everywhere else
  };

  return (
    <input
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      maxLength={60}
      placeholder={placeholder}
      aria-label="Display name"
      className="w-full max-w-xs rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm"
    />
  );
}
