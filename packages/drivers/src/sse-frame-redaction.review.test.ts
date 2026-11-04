import { buildContract, requestPolicy } from '@bugpatrol/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiDriver } from './api.js';
import { Pacer } from './api-pacer.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  [
    'interleaved event fields',
    'data: {\nevent: login\ndata: "token": "new-server-secret",\n: heartbeat\ndata: "ok": true\ndata: }\n\n',
  ],
  ['byte-limited JSON data', `data: {"token":"new-server-secret","payload":"${'x'.repeat(70_000)}"}\n\n`],
])('does not expose credentials in SSE body with %s', async (_name, body) => {
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
  expect(JSON.stringify(observation)).not.toContain('new-server-secret');
});

it.each([
  ['bytes', `data: ${'x'.repeat(70_000)}`, 65_536, 1],
  ['events', 'data: tick\n\n'.repeat(101), 1212, 100],
  ['time', 'data: tick\n\n', 12, 1],
] as const)('bounds open SSE streams by %s and cancels the reader', async (_limit, body, bytes, eventCount) => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel() {
      cancelled = true;
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })),
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
  const start = Date.now();
  expect((await driver.act({ kind: 'request', method: 'GET', url: '/events' })).ok).toBe(true);
  expect(Date.now() - start).toBeLessThan(2000);
  expect(cancelled).toBe(true);
  const observation = await driver.observe();
  expect(observation.capture.kind).toBe('http');
  if (observation.capture.kind !== 'http') throw new Error('Expected HTTP evidence');
  expect(observation.capture.exchange?.response?.bytes).toBe(bytes);
  expect(observation.capture.exchange?.response?.events).toHaveLength(eventCount);
});
