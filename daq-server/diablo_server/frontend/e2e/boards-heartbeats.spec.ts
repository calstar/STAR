import { test, expect, type Page } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Boards / Heartbeats page: **every** card must show State ACTIVE (only pass state). Also CONNECTED,
 * numeric Heartbeat Hz (not ---), Self Test ALL PASSED. Align settle with sensor-info E2E.
 */
const SETTLE_MS = Math.max(0, parseInt(process.env.E2E_SETTLE_MS ?? '5000', 10) || 5000);

interface CardBoardSnapshot {
  title: string;
  /** Failing checks only, in order: Status → State → Heartbeat → Self Test */
  failures: string[];
}

interface BoardHeartbeatResult {
  cardCount: number;
  cards: CardBoardSnapshot[];
  pageProblems: string[];
}

async function collectBoardHeartbeatResult(page: Page): Promise<BoardHeartbeatResult> {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid="boards-heartbeat-card"]'));

    if (nodes.length === 0) {
      const empty = document.querySelector('main')?.innerText ?? '';
      if (empty.includes('No boards enabled in config')) {
        return {
          cardCount: 0,
          cards: [],
          pageProblems: ['No boards enabled in config — nothing to assert'],
        };
      }
      return {
        cardCount: 0,
        cards: [],
        pageProblems: ['No board cards rendered yet (expected [data-testid=boards-heartbeat-card])'],
      };
    }

    const cards: CardBoardSnapshot[] = [];

    for (const card of nodes) {
      const title =
        (card.querySelector('h3')?.textContent ?? '').replace(/\s+/g, ' ').trim() || 'Board';
      let status = '';
      let state = '';
      card.querySelectorAll('div.flex-1.min-w-0').forEach((sec) => {
        const lab = (sec.querySelector('div.text-text-muted')?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .toUpperCase();
        const val = sec.querySelector('span.font-mono.font-bold')?.textContent?.trim() ?? '';
        if (lab === 'STATUS') status = val;
        if (lab === 'STATE') state = val;
      });

      const selfTestMatch = (card as HTMLElement).innerText.match(/Self Test:\s*([^\n\r]+)/i);
      const selfTest = (selfTestMatch?.[1] ?? '').trim();

      const hbBad = /Heartbeat:\s*---/.test((card as HTMLElement).innerText);

      /** Order: Status, State, Heartbeat, Self Test — matches user-facing failure layout */
      const failures: string[] = [];

      if (status === 'DISCONNECTED') {
        failures.push('Status DISCONNECTED (expected CONNECTED)');
      } else if (status !== 'CONNECTED') {
        failures.push(
          status ? `Status ${status} (expected CONNECTED)` : 'Status missing (expected CONNECTED)',
        );
      }

      if (state !== 'ACTIVE') {
        if (state === 'SETUP') {
          failures.push('State is SETUP (expected ACTIVE)');
        } else if (state === 'UNKNOWN') {
          failures.push('State is UNKNOWN (expected ACTIVE)');
        } else if (state) {
          failures.push(`State is ${state} (expected ACTIVE)`);
        } else {
          failures.push('State missing (expected ACTIVE)');
        }
      }

      if (hbBad) {
        failures.push('Heartbeat --- (expected numeric Hz)');
      }

      if (selfTest !== 'ALL PASSED') {
        failures.push(
          selfTest === 'UNTESTED'
            ? 'Self Test UNTESTED (expected ALL PASSED)'
            : `Self Test ${selfTest || '(missing)'} (expected ALL PASSED)`,
        );
      }

      cards.push({ title, failures });
    }

    return { cardCount: nodes.length, cards, pageProblems: [] };
  });
}

function formatBoardIssues(result: BoardHeartbeatResult): string {
  const { cardCount, cards, pageProblems } = result;
  const lines: string[] = [];

  if (cardCount > 0) {
    lines.push(
      `Rendered board cards: ${cardCount}. Pass = every card: Status CONNECTED, State ACTIVE, Heartbeat Hz, Self Test ALL PASSED.`,
    );
    lines.push('');
  }

  const failedCards = cards.filter((c) => c.failures.length > 0);
  const problemCount =
    pageProblems.length + cards.reduce((n, c) => n + c.failures.length, 0);

  lines.push(`Problems (${problemCount}):`);
  lines.push('');

  for (const p of pageProblems) {
    lines.push(`(page): ${p}`);
    lines.push('');
  }

  for (const c of failedCards) {
    lines.push(`${c.title}:`);
    for (const f of c.failures) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function assertBoardHeartbeatPass(result: BoardHeartbeatResult): void {
  const hasPage = result.pageProblems.length > 0;
  const hasCardFailures = result.cards.some((c) => c.failures.length > 0);
  if (!hasPage && !hasCardFailures) return;

  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    throw new Error(formatBoardIssues(result));
  } finally {
    Error.stackTraceLimit = prev;
  }
}

test.describe('Boards / Heartbeats page', () => {
  test('every board card is CONNECTED, State ACTIVE, heartbeat Hz, and Self Test ALL PASSED when stack is up', async ({
    page,
  }) => {
    await page.goto('/boards');
    await expect(page.getByRole('heading', { name: 'Boards / Heartbeats' })).toBeVisible();

    await delay(SETTLE_MS);

    const result = await collectBoardHeartbeatResult(page);
    assertBoardHeartbeatPass(result);
  });
});
