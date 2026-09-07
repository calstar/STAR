import { displayNameOf, initialsOf } from "@/lib/names";

/** The minimal user shape a chip needs (satisfied by Prisma `User` and
 * `AssigneeLite`). */
export type ChipUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  displayName?: string | null;
};

// Per-person color pairs: a tinted chip surface plus a solid avatar circle.
// Written as literal class strings so Tailwind's scanner picks them up.
const PALETTE = [
  { chip: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300", dot: "bg-rose-500" },
  { chip: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300", dot: "bg-orange-500" },
  { chip: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300", dot: "bg-amber-500" },
  { chip: "bg-lime-50 text-lime-700 dark:bg-lime-950 dark:text-lime-300", dot: "bg-lime-600" },
  { chip: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", dot: "bg-emerald-600" },
  { chip: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300", dot: "bg-teal-600" },
  { chip: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300", dot: "bg-sky-500" },
  { chip: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300", dot: "bg-blue-500" },
  { chip: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300", dot: "bg-violet-500" },
  { chip: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300", dot: "bg-fuchsia-500" },
];

// Deterministic hue per user so the same person is the same color everywhere
// (board, table, picker) and across sessions.
function paletteFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Solid colored circle with the person's initials. */
export function AssigneeAvatar({ user }: { user: ChipUser }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white ${paletteFor(user.id).dot}`}
    >
      {initialsOf(user)}
    </span>
  );
}

/** One person = one pill: initials avatar + short name, colored per person so
 * multiple assignees on a task read as distinct people at a glance. */
export function AssigneeChip({ user }: { user: ChipUser }) {
  return (
    <span
      className={`inline-flex max-w-full shrink-0 items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-xs font-medium ${paletteFor(user.id).chip}`}
    >
      <AssigneeAvatar user={user} />
      <span className="truncate">{displayNameOf(user)}</span>
    </span>
  );
}
