import { test, expect, type Page } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Sensor Info: cols 2–4 = raw ADC / counts, converted, Frontend Rate (Hz).
 * Uses innerText in the page so placeholders match what you see in the browser.
 *
 * Strategy: open page → wait for loading rows to clear → short settle delay → one snapshot assert.
 * Override delay with E2E_SETTLE_MS (ms).
 */

const LOADING_TIMEOUT_MS = 60_000;
const SETTLE_MS = Math.max(0, parseInt(process.env.E2E_SETTLE_MS ?? '5000', 10) || 5000);

/** Every stuck placeholder: --- in visible text, or empty value cells in table cols 2–4. */
async function collectSensorInfoIssues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const main = document.querySelector('main');
    if (!main) {
      return ['<main> not found'];
    }

    const push = (location: string, detail: string) => {
      const d = detail.replace(/\s+/g, ' ').trim().slice(0, 120);
      out.push(`${location}: ${d}`);
    };

    const packets = document.querySelector('[data-testid="sensor-info-packets-count"]');
    if (packets?.innerText?.includes('---')) {
      push('Backend Ingest / Packets', packets.innerText);
    }

    const ingest = document.querySelector('[data-testid="sensor-info-ingest-rate-hz"]');
    if (ingest?.innerText?.includes('---')) {
      push('Backend Ingest / Ingest Rate', ingest.innerText);
    }

    const scan = document.querySelector('[data-testid="sensor-info-board-scan"]');
    if (scan) {
      scan.querySelectorAll(':scope > div').forEach((col) => {
        const label =
          col.querySelector('.text-gray-500')?.textContent?.replace(/\s+/g, ' ').trim() ??
          'board group';
        const rateEl = col.querySelector('.text-cyan-400') as HTMLElement | null;
        const rateText = rateEl?.innerText ?? col.innerText;
        if (rateText.includes('---')) {
          push(`Board ingest scan rate / ${label}`, rateText);
        }
      });
    }

    main.querySelectorAll('table').forEach((table) => {
      const card = table.closest('.bg-card');
      const tableTitle =
        card?.querySelector('.border-b span.uppercase')?.textContent?.replace(/\s+/g, ' ').trim() ??
        'Table';
      const headers = [...table.querySelectorAll('thead th')].map((th) =>
        th.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      );

      table.querySelectorAll('tbody tr').forEach((tr) => {
        if (tr.querySelector('td[colspan]')) return;
        const tds = tr.querySelectorAll('td');
        if (tds.length < 2) return;
        const rowLabel = tds[0].innerText.replace(/\s+/g, ' ').trim() || '(no channel label)';

        for (let c = 1; c < tds.length; c++) {
          const cell = (tds[c] as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
          const colName = headers[c] ?? `column ${c + 1}`;
          if (cell.includes('---')) {
            push(`${tableTitle} / "${rowLabel}" / ${colName}`, cell);
          } else if (cell === '') {
            push(`${tableTitle} / "${rowLabel}" / ${colName}`, '(empty)');
          }
        }
      });
    });

    return out;
  });
}

/**
 * Human-readable failure (no Jest deep-equality +/- diff). Groups by the first path segment
 * (e.g. table title or "Backend Ingest") and bullets the rest.
 */
function formatPlaceholderFailure(issues: string[]): string {
  const groups = new Map<string, string[]>();
  for (const line of issues) {
    const idx = line.indexOf(' / ');
    if (idx === -1) {
      if (!groups.has('Other')) groups.set('Other', []);
      groups.get('Other')!.push(line);
      continue;
    }
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 3).trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(rest);
  }
  const lines: string[] = [
    `Expected 0 stuck placeholders (--- or empty cells). Found ${issues.length}:`,
    '',
  ];
  for (const key of [...groups.keys()].sort()) {
    const items = groups.get(key)!;
    lines.push(`${key} (${items.length}):`);
    for (const item of items) {
      lines.push(`  • ${item}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function assertNoPlaceholderIssues(issues: string[]): void {
  if (issues.length === 0) return;
  const msg = formatPlaceholderFailure(issues);
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    throw new Error(msg);
  } finally {
    Error.stackTraceLimit = prev;
  }
}

test.describe('Sensor Info page', () => {
  test('shows live data (no stuck placeholders in raw, converted, or rate columns) when stack is up', async ({
    page,
  }) => {
    await page.goto('/sensor-info');
    await expect(page.getByRole('heading', { name: 'Sensor Info' })).toBeVisible();

    await expect(page.getByText('Loading PT roles…')).toBeHidden({ timeout: LOADING_TIMEOUT_MS });
    await expect(page.getByText('Loading HP PT roles…')).toBeHidden({ timeout: 30_000 });

    await delay(SETTLE_MS);

    const issues = await collectSensorInfoIssues(page);

    const col2Count = await page.evaluate(() =>
      document.querySelectorAll('main table tbody tr td:nth-child(2)').length,
    );
    expect(col2Count).toBeGreaterThan(0);

    assertNoPlaceholderIssues(issues);
  });
});
