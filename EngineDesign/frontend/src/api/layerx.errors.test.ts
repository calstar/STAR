import { describe, expect, it } from 'vitest';
import { errorDetail, errorText } from './layerx';

describe('a refused request reads as the rail', () => {
  it('names the field the person typed in, not the model key', () => {
    const detail = [{ loc: ['body', 'settings', 'horizon_s'], msg: 'Input should be less than or equal to 60' }];
    expect(errorText(detail, 422)).toBe('Max burn (s): Input should be less than or equal to 60');
  });
  it('keeps a preflight refusal whole', () => {
    expect(errorText({ message: 'Preflight failed.', failing: ['Time step'] }, 422)).toBe('Preflight failed. Time step');
  });
  it('says every bad field of a 422 in the rail\u2019s words, not just the first', () => {
    // The backend's shape: one sentence, plus the per-field list.
    const body = {
      detail: 'Settings fill fraction: Input should be less than 0.99; settings dt: Input should be greater than 0.',
      errors: [
        { loc: ['body', 'settings', 'fill_fraction'], msg: 'Input should be less than 0.99' },
        { loc: ['body', 'settings', 'dt'], msg: 'Input should be greater than 0' },
      ],
    };
    expect(errorText(errorDetail(body), 422)).toBe(
      'Fill fraction: Input should be less than 0.99; Time step (s): Input should be greater than 0',
    );
    expect(errorText(errorDetail({ detail: 'Refused.' }), 409)).toBe('Refused.');
  });
});
