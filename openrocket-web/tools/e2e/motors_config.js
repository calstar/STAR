// Playwright half of tools/e2e/run.sh: drives the Motors & Configuration tab and saves the .ork to argv[2].
// Edit separation (one config), deployment (all configs), ignition delay; save the .ork.
const { open } = require('./common')
const OUT = process.argv[2]
const SHOTS = require('path').resolve(__dirname, '../../docs/screenshots') + '/'
;(async () => {
  const { browser, page } = await open()
  const sub = (name) => page.locator('[role=tab]', { hasText: new RegExp(`^${name}$`) }).click()
  const cell = (table, cfgIdx, colName) => page.locator(`[data-testid=${table}]`).evaluateHandle(
    (t, [i, name]) => {
      const heads = [...t.querySelectorAll('th')].map((h) => h.textContent)
      const col = heads.indexOf(name)
      return t.querySelectorAll('tbody tr')[i].children[col]
    }, [cfgIdx, colName])
  const click = async (table, i, col, dbl = false) => {
    const h = await cell(table, i, col)
    if (dbl) await h.asElement().dblclick()
    else await h.asElement().click()
  }
  const text = async (table, i, col) => (await cell(table, i, col)).evaluate((e) => e.textContent)
  const spin = async (dlg, label, v) => {
    const f = dlg.getByLabel(label, { exact: true })
    await f.fill(String(v))
    await f.press('Enter')
  }

  // 1. Booster separation, configuration 0 only: altitude during ascent, 300 m, + 1 s
  await sub('Stages')
  await click('separation-table', 0, 'Booster', true)
  let dlg = page.getByTestId('separation-dialog')
  await dlg.getByLabel(/^Override for the/).check()
  await dlg.locator('select').selectOption({ label: 'Specific altitude during ascent' })
  await spin(dlg, 'Altitude', 300)
  await spin(dlg, 'Delay', 1)
  await page.screenshot({ path: SHOTS + 'motors-separation-edit.png' })
  await dlg.getByRole('button', { name: 'OK' }).click()
  console.log('separation cells:', await text('separation-table', 0, 'Booster'), '|', await text('separation-table', 1, 'Booster'))

  // 2. Sustainer Drogue deployment for all configurations. Both configurations override it in
  //    this file, and "all configurations" edits the default (DeploymentSelectionDialog), so
  //    first reset each configuration to the default, as one would in OpenRocket.
  await sub('Recovery')
  for (const i of [0, 1]) {
    await click('recovery-table', i, 'Sustainer Drogue')
    await page.getByRole('button', { name: 'Reset deployment' }).click()
  }
  console.log('after reset:', await text('recovery-table', 0, 'Sustainer Drogue'), '|', await text('recovery-table', 1, 'Sustainer Drogue'))
  await click('recovery-table', 0, 'Sustainer Drogue')
  await page.getByRole('button', { name: 'Select deployment' }).click()
  dlg = page.getByTestId('deployment-dialog')
  console.log('preselected all?', await dlg.getByLabel(/^Change all configurations/).isChecked())
  await dlg.getByLabel(/^Change all configurations/).check()
  await dlg.locator('select').selectOption({ label: 'Apogee' })
  await spin(dlg, 'Delay', 1.5)
  await dlg.getByRole('button', { name: 'OK' }).click()
  console.log('deployment cells:', await text('recovery-table', 0, 'Sustainer Drogue'), '|', await text('recovery-table', 1, 'Sustainer Drogue'))
  await page.screenshot({ path: SHOTS + 'motors-recovery-edited.png' })

  // 3. Sustainer ignition delay, configuration 1 only: Burnout + 0.5 s
  await sub('Motors')
  await click('config-table', 1, 'Sustainer Motor Mount')
  await page.getByRole('button', { name: 'Select ignition' }).click()
  dlg = page.getByTestId('ignition-dialog')
  console.log('ignition preselected override?', await dlg.getByLabel(/^Override for the/).isChecked())
  await spin(dlg, 'Ignition delay', 0.5)
  await dlg.getByRole('button', { name: 'OK' }).click()
  console.log('ignition cells:', await text('config-table', 0, 'Sustainer Motor Mount'), '|', await text('config-table', 1, 'Sustainer Motor Mount'))
  await page.screenshot({ path: SHOTS + 'motors-motors-edited.png' })

  // Back to the configuration the file had selected, so the save differs only by the edits.
  await page.getByLabel('Flight configuration').selectOption({ index: 0 })
  await page.waitForTimeout(500)
  // 4. File > Save
  const dl = page.waitForEvent('download')
  await page.locator('.orw-menubar >> text=File').first().click()
  await page.locator('.orw-mi', { hasText: /^Save/ }).first().click()
  const d = await dl
  await d.saveAs(OUT)
  console.log('saved', OUT, d.suggestedFilename())
  await browser.close()
})()
