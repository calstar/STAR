import { formatPoints } from "@/lib/leaderboard";

/** A filled star, the mark for task points everywhere they appear. */
export function IconStar({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8Z" />
    </svg>
  );
}

/** A task's points as a small violet pill: "★ 30". */
export function PointsBadge({ points }: { points: number }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium tabular-nums bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
      title={`${formatPoints(points)} points`}
    >
      <IconStar />
      {formatPoints(points)}
    </span>
  );
}
