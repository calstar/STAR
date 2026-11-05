import { type Page, test as base, expect } from "@playwright/test";

// React's hydration-mismatch warning. `next dev` prints it and a production
// build does not, so failing on it would make a local run (next dev) red where
// CI (next start) is green. It is recorded on the test instead. Known case: the
// sidebar's active-project link after a reload of /projects/<id>.
const HYDRATION = /hydrat(ed|ion).*didn't match|hydration-mismatch/i;

/**
 * `page`, failing the test on any uncaught error or console error the page
 * throws, so a page that renders but is broken underneath still goes red.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, provide, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      if (HYDRATION.test(m.text())) {
        testInfo.annotations.push({ type: "hydration-mismatch", description: m.text().slice(0, 300) });
      } else {
        errors.push(`console.error: ${m.text()}`);
      }
    });
    await provide(page);
    expect(errors, "the page logged errors").toEqual([]);
  },
});

export { expect };

/** A title nobody else will have, so a test can find exactly its own task. */
export const unique = (what: string) => `${what} ${Date.now().toString(36)}`;

/** The page body to the right of the sidebar (the app has no <main> landmark),
 * so a project name finds the page's link, not the sidebar's. */
export const content = (page: Page) => page.locator("aside + *").first();

/** The sidebar. */
export const sidebar = (page: Page) => page.locator("aside").first();

/** Open a project from the Projects page by its name. */
export async function openProject(page: Page, name: string) {
  await page.goto("/projects");
  await content(page).getByRole("listitem").getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}
