// Opens the live UI (http://localhost:5178) on an example and switches to Motors & Configuration.
const { chromium } = require('playwright')
async function open(example = 'Two stage high power rocket') {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()))
  await page.goto('http://localhost:5178/')
  await page.locator('.orw-menubar').waitFor()
  await page.locator('.orw-menubar >> text=File').first().click()
  await page.locator('.orw-mi', { hasText: 'Open example' }).hover()
  await page.locator('.orw-mi:not([role=menuitem])', { hasText: example }).click()
  await page.waitForTimeout(1500)
  await page.locator('[role=tab]', { hasText: 'Motors & Configuration' }).click()
  await page.waitForTimeout(800)
  return { browser, page }
}
module.exports = { open }
