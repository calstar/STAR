import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemsFrom } from '../lib/scrape.mjs';

const q = (question, answer, files = []) => ({ question, answer, files });

test('reads items, including the form\'s "Iterm #3" and "Upload Item #N" labels', () => {
  const items = itemsFrom([
    q('Item #1: Vendor name (Include name of vendor listed on receipt)', 'McMaster-Carr'),
    q('Item #1: Total of Expense (Include the total amount)', '12.34'),
    q('Item #1: Upload Receipt/Invoice/Contracted Service Agreement', 'a.pdf', [{ name: 'a.pdf' }]),
    q('Iterm #3: Date of Expense (Include date of transaction)', '6/26/2026'),
    q('Item #3: Vendor name (Include name of vendor listed on receipt)', 'Amazon'),
    q('Upload Item #3 file here. See Item #1 upload for further instructions.', 'c.pdf', [{ name: 'c.pdf' }]),
    q('Item #4: Vendor name (Include name of vendor listed on receipt)', null),
  ]);
  assert.deepEqual(items.map(i => i.item), [1, 3]);
  assert.equal(items[1].date, '6/26/2026');
  assert.deepEqual(items[1].receipt, [{ name: 'c.pdf' }]);
});
