// Reverse-engineering aid used while mapping CalLink (read-only). Not part of the worker.
// Read-only: load the purchase-request form and print every question, its kind, and its options.
import { chromium } from 'playwright';
import { PROFILE, RUNS } from '../lib/callink.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://callink.berkeley.edu/actionCenter/organization/star/Finance/CreatePurchaseRequest', { waitUntil: 'networkidle' });
const map = await page.evaluate(() => {
  const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('#finance_form .form-group')].map(g => {
    const label = clean((g.querySelector('.label-set, label, legend') || {}).innerText).slice(0, 110);
    const inputs = [...g.querySelectorAll('input:not([type=hidden]), select, textarea, button')];
    return {
      label, required: g.classList.contains('required'),
      fields: inputs.map(i => ({
        tag: i.tagName.toLowerCase(), type: i.type, name: i.name, id: i.id,
        option: i.type === 'radio' || i.type === 'checkbox' ? clean(i.closest('label')?.innerText).slice(0, 70) : undefined,
        text: i.tagName === 'BUTTON' ? clean(i.innerText) : undefined,
        options: i.tagName === 'SELECT' ? [...i.options].map(o => `${o.value}=${clean(o.text)}`).slice(0, 12) : undefined,
      })),
    };
  });
});
fs.writeFileSync(path.join(RUNS, '..', 'callink-explore', 'formmap.json'), JSON.stringify(map, null, 1));
for (const q of map) {
  console.log(`${q.required ? '*' : ' '} ${q.label}`);
  for (const f of q.fields) console.log(`     ${f.tag}/${f.type} ${f.name || f.id}${f.option ? ' :: ' + f.option : ''}${f.text ? ' [' + f.text + ']' : ''}${f.options ? ' ' + f.options.join(' | ') : ''}`);
}
await ctx.close();
