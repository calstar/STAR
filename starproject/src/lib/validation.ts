import { z } from "zod";

export const TaskStatusEnum = z.enum(["backlog", "todo", "in_progress", "done", "blocked"]);
export const TaskPriorityEnum = z.enum(["low", "medium", "high"]);

// FormData gives strings (and "" for empty). Treat "" / null as "not set".
const emptyToUndef = (v: unknown) => (v === "" || v == null ? undefined : v);

// Assignees travel as a single comma-separated list of user ids (cuids contain
// no commas). "" / null / missing → no assignees.
export const csvToIds = (v: unknown): string[] =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];

// A native <input type="date"> accepts a 5–6 digit year (e.g. "12345-09-03") — a
// valid input value that JS still parses to an Invalid Date, which crashes the
// request downstream. Bound the year to 4 digits everywhere a task date is taken.
const MIN_YEAR = 1900;
const MAX_YEAR = 9999;
const yearInRange = (d: Date) =>
  d.getFullYear() >= MIN_YEAR && d.getFullYear() <= MAX_YEAR;

export function isValidDateInput(s: string): boolean {
  if (s.trim() === "") return true; // empty = no date
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && yearInRange(d);
}

const taskDate = z.preprocess(
  emptyToUndef,
  z.coerce
    .date()
    .refine(yearInRange, {
      message: `Enter a 4-digit year between ${MIN_YEAR} and ${MAX_YEAR}.`,
    })
    .optional(),
);

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
  color: z.preprocess(emptyToUndef, z.string().trim().max(20).optional()),
  parentId: z.preprocess(emptyToUndef, z.string().optional()),
});

// A task's points: a whole number 0–1000, or "" / null for none. No negatives.
export const MAX_TASK_POINTS = 1000;
export const TaskPointsInput = z.preprocess(
  (v) => (v === "" || v == null ? null : v),
  z.coerce
    .number()
    .int("Points must be a whole number.")
    .min(0, "Points can't be negative.")
    .max(MAX_TASK_POINTS, `Points can be at most ${MAX_TASK_POINTS}.`)
    .nullable(),
);

export const taskCreateSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1, "Title is required").max(300),
  description: z.preprocess(emptyToUndef, z.string().trim().max(5000).optional()),
  priority: z.preprocess(emptyToUndef, TaskPriorityEnum.optional()),
  assigneeIds: z.preprocess(csvToIds, z.array(z.string())),
  subteamId: z.preprocess(emptyToUndef, z.string().optional()),
  startDate: taskDate,
  dueDate: taskDate,
  points: TaskPointsInput.optional(),
});

export const subteamCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  color: z.preprocess(emptyToUndef, z.string().trim().max(20).optional()),
});
