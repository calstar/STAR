import { type Page } from "@playwright/test";

import { content, expect, openProject, test, unique } from "./fixtures";

// The task workflow end to end: create, find, open, edit. Each step is a
// feature that has to keep working, not just keep compiling.

const headerRow = (page: Page) => page.getByRole("table").getByRole("row").first();
const rowFor = (page: Page, title: string) =>
  page.getByRole("table").getByRole("row").filter({ hasText: title });

async function addTask(page: Page, project: string, title: string) {
  await openProject(page, project);
  await page.getByPlaceholder("New task…").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(rowFor(page, title)).toBeVisible();
}

test("the tasks page has List, Board and Timeline views", async ({ page }) => {
  await page.goto("/tasks");
  const body = content(page);
  await body.getByRole("button", { name: "Board", exact: true }).click();
  for (const col of ["Backlog", "To do", "In progress", "Blocked", "Done"]) {
    await expect(body.getByText(col, { exact: true }).first(), col).toBeVisible();
  }
  await body.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await body.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
});

test("the list shows the seeded tasks with their columns", async ({ page }) => {
  await page.goto("/tasks");
  for (const h of ["Task", "Project", "Status", "Priority", "Assignees", "Due"]) {
    await expect(headerRow(page), h).toContainText(h);
  }
  await expect(rowFor(page, "Lay out flight computer rev B")).toBeVisible();
});

test("the tasks page has its filters: search, My tasks, status, projects", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByPlaceholder("Search tasks…")).toBeVisible();
  await expect(page.getByRole("switch", { name: "My tasks" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Filter by status" })).toBeVisible();
  await expect(content(page).getByRole("button", { name: "LE4", exact: true })).toBeVisible();
});

test("search narrows the list", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByPlaceholder("Search tasks…").fill("injector");
  await expect(rowFor(page, "Machine injector plate")).toBeVisible();
  await expect(rowFor(page, "Lay out flight computer rev B")).toHaveCount(0);
});

test("My tasks shows only what is assigned to me", async ({ page }) => {
  const title = unique("E2E mine");
  await addTask(page, "Luna", title);
  await rowFor(page, title).getByRole("combobox", { name: "Assignees" }).click();
  await page.getByRole("option", { name: /E2E/ }).click();
  await page.keyboard.press("Escape");

  await page.goto("/tasks");
  await page.getByRole("switch", { name: "My tasks" }).click();
  await expect(rowFor(page, title)).toBeVisible();
  await expect(rowFor(page, "Machine injector plate")).toHaveCount(0);
});

test("a task added on a project page appears in its list and opens", async ({ page }) => {
  const title = unique("E2E task");
  await addTask(page, "Luna", title);
  // Clicking a row opens the task in place, over the list, and it closes again.
  // (The modal has no dialog role, so its Close button is the handle.)
  await rowFor(page, title).getByText(title).click();
  const close = page.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeVisible();
  await expect(page.getByText("Loading…")).toHaveCount(0);
  await expect(page.getByText("Task not found.")).toHaveCount(0);
  await close.click();
  await expect(close).toHaveCount(0);
});

test("a status change sticks after a reload", async ({ page }) => {
  const title = unique("E2E status");
  await addTask(page, "Luna", title);
  await rowFor(page, title).getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "In progress" }).click();
  await expect(rowFor(page, title).getByRole("combobox", { name: "Status" })).toContainText("In progress");

  await page.reload();
  await expect(rowFor(page, title).getByRole("combobox", { name: "Status" })).toContainText("In progress");
});
