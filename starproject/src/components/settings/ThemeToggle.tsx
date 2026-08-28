"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setTheme } from "@/lib/actions/settings";

export function ThemeToggle({ theme }: { theme: string }) {
  const [dark, setDark] = useState(theme === "dark");
  const router = useRouter();

  const toggle = () => {
    const next = !dark;
    setDark(next);
    // Instant feedback, then persist and re-render the server tree.
    document.documentElement.classList.toggle("dark", next);
    setTheme(next ? "dark" : "light").then(() => router.refresh());
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={toggle}
        role="switch"
        aria-checked={dark}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          dark ? "bg-neutral-900" : "bg-neutral-300"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            dark ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
      <span className="text-sm">{dark ? "Dark" : "Light"} mode</span>
    </div>
  );
}
