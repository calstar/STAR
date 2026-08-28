// frappe-gantt ships no TypeScript types; we drive it dynamically as `any`.
// The dist builds are bare global scripts, so we import the package's ESM
// source entry (compiled via sass) — see GanttChart.tsx.
declare module "frappe-gantt";
