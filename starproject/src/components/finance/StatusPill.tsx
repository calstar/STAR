import { TONE_BADGE, type Tone } from "@/lib/finance/status";

export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${TONE_BADGE[tone]}`}>
      {label}
    </span>
  );
}
