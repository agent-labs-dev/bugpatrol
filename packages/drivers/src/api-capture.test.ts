import { describe, expect, it } from 'vitest';
import { responseCaptures } from './api.js';

describe('API response captures', () => {
  it('keeps an owner resource id but rejects credential fields and parents', () => {
    const body = JSON.stringify({
      browser_session: { id: 'sess_123' },
      token: 'secret',
      credentials: { key: 'secret' },
    });
    expect(responseCaptures(200, body, { RESPONSE_SESSION: '/browser_session/id' })).toEqual({
      RESPONSE_SESSION: 'sess_123',
    });
    expect(() => responseCaptures(200, body, { RESPONSE_TOKEN: '/token' })).toThrow('credential field');
    expect(() => responseCaptures(200, body, { RESPONSE_CREDENTIALS: '/credentials' })).toThrow('credential field');
  });
});
