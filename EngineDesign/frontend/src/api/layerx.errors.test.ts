import { describe, expect, it } from 'vitest';
import { errorText } from './layerx';

describe('a refused request reads as the rail', () => {
  it('names the field the person typed in, not the model key', () => {
    const detail = [{ loc: ['body', 'settings', 'horizon_s'], msg: 'Input should be less than or equal to 60' }];
    expect(errorText(detail, 422)).toBe('Max burn (s): Input should be less than or equal to 60');
  });
  it('keeps a preflight refusal whole', () => {
    expect(errorText({ message: 'Preflight failed.', failing: ['Time step'] }, 422)).toBe('Preflight failed. Time step');
  });
});
