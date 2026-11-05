import { expect, sidebar, test } from "./fixtures";

// Every page in the sidebar opens, shows its heading and throws nothing. The
// cheapest net there is: a page a merge broke or unlinked fails here first.
const PAGES: { path: string; heading: RegExp }[] = [
  { path: "/tasks", heading: /tasks/i },
  { path: "/projects", heading: /^projects$/i },
  { path: "/subteams", heading: /subteams/i },
  { path: "/activity/leaderboard", heading: /activity|leaderboard/i },
  { path: "/purchase-requests", heading: /purchase requests/i },
  { path: "/reimbursements", heading: /reimbursements/i },
  { path: "/settings", heading: /settings/i },
  { path: "/workspace", heading: /workspace/i },
];

test("the health page sees the database and who we are", async ({ page }) => {
  await page.goto("/health");
  await expect(page.getByText("e2e@berkeley.edu")).toBeVisible();
});

for (const { path, heading } of PAGES) {
  test(`${path} opens`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status(), `${path} status`).toBeLessThan(400);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  });
}

test("the sidebar links every main page", async ({ page }) => {
  await page.goto("/");
  const nav = sidebar(page);
  const links: [string, string][] = [
    ["Home", "/"],
    ["Tasks", "/tasks"],
    ["Activity", "/activity/leaderboard"],
    ["Reimbursements", "/reimbursements"],
    ["Purchase Requests", "/purchase-requests"],
    ["Finance", "/finance"], // admins only; the e2e user is one
    ["Projects", "/projects"],
    ["Subteams", "/subteams"],
  ];
  for (const [label, href] of links) {
    await expect(nav.locator(`a[href="${href}"]`).filter({ hasText: label }).first(), label).toBeVisible();
  }
});
