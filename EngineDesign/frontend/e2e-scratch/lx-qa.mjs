// Scratch visual QA for the rebuilt Layer X: every Burn page, both tools and the gallery, at the
// given widths and themes. Screenshots (viewport and the main column's full height), console
// errors, axe (all rules, color-contrast called out) and three geometric checks done in the page:
//   overlap  -- two visible text boxes that intersect
//   clipped  -- text cut by an overflow box with no ellipsis (and, separately, ellipsised text)
//   orphan   -- a unit element that landed on a different line from the number before it
// Not a test suite. Env: OUT (dir), SIZES ("1440x900,1920x1080"), THEMES ("dark,light"),
// PAGES, TOOLS ("injector,optimize"), GALLERY (1/0), AXE (1/0), FULL (1/0).
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import { geometry } from './qa-geometry.mjs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = process.env.OUT ?? new URL('./shots/qa/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = (process.env.SIZES ?? '1440x900,1920x1080').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const PAGES = (process.env.PAGES ?? 'overview,feed,engine,hardware,flight,stand,uncertainty,record').split(',').filter(Boolean);
const TOOLS = (process.env.TOOLS ?? 'injector,optimize').split(',').filter(Boolean);
const GALLERY = (process.env.GALLERY ?? '1') === '1';
const AXE = (process.env.AXE ?? '1') === '1';
const FULL = (process.env.FULL ?? '1') === '1';

const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const latest = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started);
const RUN = process.env.RUN ?? latest[0].id;
const VS = process.env.VS ?? '';

const report = { run: RUN, shots: [], console: [], axe: [], overlap: [], clipped: [], ellipsis: [], orphan: [] };

const browser = await chromium.launch();

async function check(page, tag, rootSel = '.lx') {
  const g = await page.evaluate(geometry, rootSel);
  for (const k of ['overlap', 'clipped', 'ellipsis', 'orphan']) for (const x of g[k]) report[k].push({ tag, ...x });
  if (AXE) {
    try {
      const res = await new AxeBuilder({ page }).include(rootSel).analyze();
      for (const v of res.violations) {
        report.axe.push({ tag, id: v.id, impact: v.impact, n: v.nodes.length, help: v.help,
          nodes: v.nodes.slice(0, 6).map((x) => `${x.target.join(' ')} :: ${(x.failureSummary ?? '').split('\n').slice(1, 2).join(' ').slice(0, 200)}`) });
      }
    } catch (e) { report.axe.push({ tag, id: 'axe-error', help: String(e).slice(0, 200) }); }
  }
}

async function shoot(page, file, scrollSel) {
  await page.screenshot({ path: file });
  report.shots.push(file);
  if (!FULL || !scrollSel) return;
  const extra = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.scrollHeight - el.clientHeight : 0;
  }, scrollSel);
  if (extra > 4) {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: vp.height + extra });
    await page.waitForTimeout(500);
    const f2 = file.replace(/\.png$/, '-full.png');
    await page.screenshot({ path: f2 });
    report.shots.push(f2);
    return { vp, full: f2 };
  }
  return null;
}

const MAIN = '.lx [data-lx-main]';

for (const [W, H] of SIZES) {
  for (const theme of THEMES) {
    const mk = async (view) => {
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      await ctx.addInitScript(([t, v]) => {
        try {
          const k = 'engine-design.view.v1';
          const s = JSON.parse(localStorage.getItem(k) || '{}');
          s['lx.theme'] = t;
          s['layerx.view'] = v;
          localStorage.setItem(k, JSON.stringify(s));
        } catch { /* */ }
      }, [theme, view]);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => report.console.push({ tag: `${W}-${theme}`, type: 'pageerror', text: e.message.slice(0, 300) }));
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') report.console.push({ tag: `${W}-${theme}`, type: m.type(), text: m.text().slice(0, 300) });
      });
      return { ctx, page };
    };

    if (PAGES.length) {
      const { ctx, page } = await mk('burn');
      for (const p of PAGES) {
        const tag = `${p}-${W}-${theme}`;
        await page.setViewportSize({ width: W, height: H });
        await page.goto(`${BASE}/?lx=2&run=${RUN}&page=${p}${VS ? `&vs=${VS}` : ''}`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.lx-tl-readout', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1600);
        await check(page, tag);
        const r = await shoot(page, `${OUT}${tag}${VS ? '-vs' : ''}.png`, MAIN);
        if (r) {
          // Geometry again at full height: everything below the fold is now on screen.
          const g = await page.evaluate(geometry, '.lx');
          for (const k of ['overlap', 'clipped', 'orphan']) for (const x of g[k]) report[k].push({ tag: `${tag}-full`, ...x });
          await page.setViewportSize(r.vp);
        }
        console.log('done', tag);
      }
      await ctx.close();
    }
    for (const tool of TOOLS) {
      const view = tool === 'injector' ? 'reconcile' : 'optimise';
      const { ctx, page } = await mk(view);
      const tag = `${tool}-${W}-${theme}`;
      await page.goto(`${BASE}/?lx=2&run=${RUN}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.lx', { timeout: 30000 });
      await page.waitForTimeout(2500);
      await check(page, tag);
      const r = await shoot(page, `${OUT}${tag}.png`, MAIN);
      if (r) {
        const g = await page.evaluate(geometry, '.lx');
        for (const k of ['overlap', 'clipped', 'orphan']) for (const x of g[k]) report[k].push({ tag: `${tag}-full`, ...x });
      }
      console.log('done', tag);
      await ctx.close();
    }
  }
  if (GALLERY) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => report.console.push({ tag: `gallery-${W}`, type: 'pageerror', text: e.message.slice(0, 300) }));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') report.console.push({ tag: `gallery-${W}`, type: m.type(), text: m.text().slice(0, 300) }); });
    await page.goto(`${BASE}/?lx-gallery=1`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await check(page, `gallery-ui-${W}`, 'body');
    await page.screenshot({ path: `${OUT}gallery-ui-${W}.png`, fullPage: true });
    report.shots.push(`${OUT}gallery-ui-${W}.png`);
    await page.getByRole('button', { name: 'Charts and timeline' }).click();
    await page.waitForTimeout(1200);
    for (const theme of THEMES) {
      await page.getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light' }).click().catch(async () => {
        await page.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light' }).click();
      });
      await page.waitForTimeout(600);
      await check(page, `gallery-charts-${W}-${theme}`, '.lx');
      await page.screenshot({ path: `${OUT}gallery-charts-${W}-${theme}.png`, fullPage: true });
      report.shots.push(`${OUT}gallery-charts-${W}-${theme}.png`);
    }
    await ctx.close();
  }
}

await browser.close();
fs.writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 1));
const summary = (k) => `${k}: ${report[k].length}`;
console.log(['console', 'axe', 'overlap', 'clipped', 'ellipsis', 'orphan'].map(summary).join(' · '));
