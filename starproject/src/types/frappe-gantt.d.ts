// frappe-gantt ships no TypeScript types; we drive it dynamically as `any`.
// Its package `main` is raw ESM+SCSS source, so we import the prebuilt UMD dist
// instead (see GanttChart.tsx) to avoid pulling a Sass toolchain into the build.
declare module "frappe-gantt";
declare module "frappe-gantt/dist/frappe-gantt.min.js";
