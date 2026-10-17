import { describe, expect, it } from 'vitest';
import { errorText, thrownText } from './errors';

describe('errorText', () => {
  it('keeps a server sentence', () => {
    expect(errorText('No config loaded. Upload a config file first.', 400)).toBe('No config loaded. Upload a config file first.');
  });
  it('flattens a FastAPI validation list into one sentence, never [object Object]', () => {
    const detail = [
      { loc: ['body', 'lox_pressure_psi'], msg: 'Input should be greater than 0', type: 'greater_than' },
      { loc: ['body', 'fuel_pressure_psi'], msg: 'Field required', type: 'missing' },
    ];
    const text = errorText(detail, 422);
    expect(text).toBe('Lox pressure psi: Input should be greater than 0 (and 1 more).');
    expect(text).not.toContain('[object');
  });
  it('reads a nested message', () => {
    expect(errorText({ message: 'preflight failed' }, 422)).toBe('Preflight failed.');
  });
  it('says something plain when the server sent nothing usable', () => {
    expect(errorText(undefined, 502)).toBe('The engine design server is not answering.');
    expect(errorText({}, 500)).toBe('The server hit an error.');
  });
  it('names a request that never reached the server', () => {
    expect(thrownText(new TypeError('Failed to fetch'))).toBe('Could not reach the engine design server.');
  });
});
