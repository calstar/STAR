"use client";

import { useState } from "react";

import { type EmailPref, setEmailPref } from "@/lib/actions/settings";

export function EmailPrefToggle({
  field,
  label,
  value,
}: {
  field: EmailPref;
  label: string;
  value: boolean;
}) {
  const [on, setOn] = useState(value);

  const toggle = () => {
    const next = !on;
    setOn(next);
    setEmailPref(field, next);
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <button
        onClick={toggle}
        role="switch"
        aria-checked={on}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          on ? "bg-green-600" : "bg-neutral-300"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            on ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
