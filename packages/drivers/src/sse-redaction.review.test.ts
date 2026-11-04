import { buildContract, requestPolicy } from '@bugpatrol/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiDriver } from './api.js';
import { Pacer } from './api-pacer.js';

afterEach(() => vi.unstubAllGlobals());

it('redacts credential keys in multiline SSE JSON from the body as well as parsed events', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('event: login\ndata: {\ndata: "token": "new-server-secret",\ndata: "ok": true\ndata: }\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
  );
  const driver = new ApiDriver({
    url: 'https://api.test',
    credentials: { self: {} },
    policy: requestPolicy(buildContract({ openapi: '3.1.0', paths: {} }, {}), {
      url: 'https://api.test',
      methods: ['GET'],
      deny: [],
      disposable: false,
    }),
    pacer: new Pacer({ perMinute: 60_000 }),
    timeoutMs: 2000,
    redact: (text) => text,
  });
  expect((await driver.act({ kind: 'request', method: 'GET', url: '/events' })).ok).toBe(true);
  const observation = await driver.observe();
  expect(JSON.stringify(observation)).not.toContain('new-server-secret');
});
