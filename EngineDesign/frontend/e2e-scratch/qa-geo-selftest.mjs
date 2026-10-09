// Self-test of qa-geometry: plant an overlap, a clipped label, an ellipsis and an orphaned unit
// in a blank .lx page and confirm each check finds its plant (a check that cannot fail is not one).
import { chromium } from 'playwright';
import { geometry } from './qa-geometry.mjs';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.setContent(`<div class="lx" style="font:13px sans-serif">
  <div style="position:relative;height:40px"><span style="position:absolute;left:10px;top:0">Overlapping A text</span><span style="position:absolute;left:30px;top:2px">Overlapping B text</span></div>
  <div style="width:60px;overflow:hidden;white-space:nowrap">clipped without ellipsis here</div>
  <div style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">ellipsised long label</div>
  <div style="width:44px">578.3 <span class="lx-unit">psia</span></div>
  <div style="width:42px">x 578 psia</div>
  <div style="position:relative;height:40px"><span style="position:absolute;left:10px;top:0">Fine</span><span style="position:absolute;left:200px;top:0">Apart</span></div>
</div>`);
const g = await page.evaluate(geometry, '.lx');
console.log(JSON.stringify({ overlap: g.overlap.length, clipped: g.clipped.length, ellipsis: g.ellipsis.length, orphan: g.orphan.length }));
console.log(JSON.stringify(g, null, 1).slice(0, 1500));
await browser.close();
