import { z } from "zod";

export const TaskStatusEnum = z.enum(["backlog", "todo", "in_progress", "done"]);
export const TaskPriorityEnum = z.enum(["low", "medium", "high"]);

// FormData gives strings (and "" for empty). Treat "" / null as "not set".
const emptyToUndef = (v: unknown) => (v === "" || v == null ? undefined : v);

// Assignees travel as a single comma-separated list of user ids (cuids contain
// no commas). "" / null / missing → no assignees.
export const csvToIds = (v: unknown): string[] =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
  color: z.preprocess(emptyToUndef, z.string().trim().max(20).optional()),
  parentId: z.preprocess(emptyToUndef, z.string().optional()),
});

export const taskCreateSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1, "Title is required").max(300),
  description: z.preprocess(emptyToUndef, z.string().trim().max(5000).optional()),
  priority: z.preprocess(emptyToUndef, TaskPriorityEnum.optional()),
  assigneeIds: z.preprocess(csvToIds, z.array(z.string())),
  subteamId: z.preprocess(emptyToUndef, z.string().optional()),
  startDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
  dueDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
});

export const subteamCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  color: z.preprocess(emptyToUndef, z.string().trim().max(20).optional()),
});
