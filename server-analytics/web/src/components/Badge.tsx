import { TONE, type Tone } from "../ui";

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${TONE[tone]}`}>{children}</span>;
}

/** Container/host state as a badge: the word is always there, color only backs it up. */
export function StateBadge({ state, health }: { state: string; health?: string }) {
  if (health === "unhealthy") return <Badge tone="red">unhealthy</Badge>;
  if (state === "running") return <Badge tone="green">{health === "starting" ? "starting" : "running"}</Badge>;
  if (state === "restarting") return <Badge tone="amber">restarting</Badge>;
  if (state === "exited" || state === "dead") return <Badge tone="red">{state}</Badge>;
  return <Badge tone="slate">{state || "unknown"}</Badge>;
}

export function UpBadge({ up }: { up: boolean }) {
  return up ? <Badge tone="green">● up</Badge> : <Badge tone="red">○ down</Badge>;
}
