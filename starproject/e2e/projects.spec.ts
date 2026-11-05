import { content, expect, openProject, test } from "./fixtures";

test("projects list the seeded tree", async ({ page }) => {
  await page.goto("/projects");
  const list = content(page).getByRole("list").first();
  for (const name of ["Luna", "SSEP3", "LE4"]) {
    await expect(list.getByRole("link", { name, exact: true }), name).toBeVisible();
  }
});

test("a project page has its List, Board, Timeline and BOM tabs", async ({ page }) => {
  await openProject(page, "LE4");
  const body = content(page);
  for (const tab of ["List", "Board", "Timeline", "BOM"]) {
    await expect(body.getByRole("link", { name: tab, exact: true }).first(), tab).toBeVisible();
  }
  // Tasks of subprojects roll up into the parent's list, with a Subproject column.
  await expect(page.getByRole("table").getByRole("row").first()).toContainText("Subproject");
  await expect(page.getByRole("table")).toContainText("Lay out flight computer rev B");
});

test("the BOM tab shows the project's lines", async ({ page }) => {
  await openProject(page, "LE4");
  await content(page).getByRole("link", { name: "BOM", exact: true }).first().click();
  await expect(page).toHaveURL(/view=bom/);
  await expect(page.getByText("Predicted (incl. shipping)")).toBeVisible();
  await expect(page.getByRole("link", { name: "Export .xlsx" })).toBeVisible();
  // A section per project in the subtree, each with its line count (the line
  // names themselves are editable inputs, not text).
  const table = page.getByRole("table");
  await expect(table).toContainText("LE4 (general)");
  await expect(table).toContainText("LE4 Recovery7 lines");
});
