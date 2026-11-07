import { describe, expect, it } from 'vitest';
import { loadLine } from './Study';

describe('the Study header', () => {
  it('gives every tank\'s load its unit', () => {
    const line = loadLine([
      { label: 'Eth-Tank', fire_load_kg: 4.4, load_kg: 5 },
      { label: 'LOX-Tank', fire_load_kg: 6.61, load_kg: 7 },
    ]);
    expect(line).toBe('load Eth-Tank 4.40 kg · LOX-Tank 6.61 kg');
  });

  it('says the fire load a short tank falls under, in kg too', () => {
    expect(loadLine([{ label: 'LOX-Tank', fire_load_kg: 6.61, load_kg: 6 }])).toBe('load LOX-Tank 6.00 kg of 6.61 kg');
  });
});
