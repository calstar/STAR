/**
 * PressureBar showLimits: the top bar's per-limit checkbox ([pressure_limits.<key>].show_in_top_bar).
 * Off removes the NOP/MEOP lines and their numbers, and nothing else — a bar past MEOP must still
 * read red, since hiding a line is a display choice and not a reason to hide an over-pressure.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import PressureBar from '../components/plots/PressureBar';

afterEach(cleanup);

const NOP = 512;
const MEOP = 734;

describe('PressureBar showLimits', () => {
  it('draws both limit lines and their numbers by default', () => {
    const { container } = render(<PressureBar label="LOX UP" value={100} nop={NOP} meop={MEOP} />);
    expect(container.textContent).toContain(String(NOP));
    expect(container.textContent).toContain(String(MEOP));
    expect(container.querySelectorAll('.border-dashed')).toHaveLength(2);
  });

  it('draws neither lines nor numbers when off', () => {
    const { container } = render(<PressureBar label="LOX UP" value={100} nop={NOP} meop={MEOP} showLimits={false} />);
    expect(container.textContent).not.toContain(String(NOP));
    expect(container.textContent).not.toContain(String(MEOP));
    expect(container.querySelectorAll('.border-dashed')).toHaveLength(0);
  });

  it('still reads red past MEOP with the limits hidden', () => {
    const { container } = render(<PressureBar label="LOX UP" value={900} nop={NOP} meop={MEOP} showLimits={false} />);
    const html = container.innerHTML;
    expect(html).toMatch(/#f87171|#ef4444|rgb\(248, 113, 113\)|rgb\(239, 68, 68\)/);
  });
});
