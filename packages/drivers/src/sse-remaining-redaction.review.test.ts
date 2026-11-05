import { buildContract, requestPolicy } from '@bugpatrol/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiDriver } from './api.js';
import { Pacer } from './api-pacer.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['object', '{"credentials":{"scope":"read","value":"new-server-secret"}'],
  ['array', '{"token":["first-server-secret","new-server-secret"]'],
])('redacts a credential %s value when a later field hits the SSE byte limit', async (_name, prefix) => {
  const body = `data: {\ndata: ${prefix.slice(1)},"payload":"${'x'.repeat(70_000)}"}\n\n`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
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
  expect(JSON.stringify(observation).includes('new-server-secret')).toBe(false);
});
