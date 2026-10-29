import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pacer } from './api-pacer.js';

describe('Pacer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  /** Resolves the turn, and gives how long it took on the fake clock. */
  async function waited(pacer: Pacer): Promise<number> {
    const started = Date.now();
    let done = false;
    const turn = pacer.acquire().then(() => {
      done = true;
    });
    while (!done) await vi.advanceTimersByTimeAsync(100);
    await turn;
    return Date.now() - started;
  }

  it('waits the seconds of Retry-After', async () => {
    const pacer = new Pacer({ perMinute: 6000 });
    await waited(pacer);
    expect(pacer.onResponse(429, '3')).toBe('retry');
    expect(await waited(pacer)).toBe(3000);
  });

  it('waits until the date of Retry-After', async () => {
    const pacer = new Pacer({ perMinute: 6000 });
    expect(pacer.onResponse(503, 'Thu, 29 Oct 2026 12:00:02 GMT')).toBeUndefined();
    expect(await waited(pacer)).toBe(2000);
  });

  it('gives up on a 429 that asks for more than a minute', async () => {
    const pacer = new Pacer();
    expect(pacer.onResponse(429, '3600')).toBe('rate-limited');
    expect(pacer.onResponse(200, '3600')).toBeUndefined();
  });
});
