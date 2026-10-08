import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiDriver } from './api.js';
import { readCast } from './cast.js';

describe('API driver against real HTTP and Chromium', () => {
  let server: Server;
  let collector: Server;
  let driver: ApiDriver;
  let origin: string;
  let otherOrigin: string;
  let leaks = 0;
  let ids = 0;
  beforeAll(async () => {
    collector = createServer((_request, response) => {
      leaks++;
      response.end('unexpected');
    });
    collector.listen(0, '127.0.0.1');
    await once(collector, 'listening');
    const other = collector.address();
    if (!other || typeof other === 'string') throw new Error('No collector port');
    otherOrigin = `http://127.0.0.1:${other.port}`;
    server = createServer(async (request, response) => {
      if (request.url === '/entities') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ result: { id: `entity-${++ids}` }, accessToken: 'new-secret' }));
        return;
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { location: otherOrigin });
        response.end();
        return;
      }
      if (request.url === '/slow') {
        setTimeout(() => response.end('late'), 300);
        return;
      }
      if (request.url === '/big') {
        response.end('x'.repeat(1024 * 1024 + 1));
        return;
      }
      if (request.url === '/html') {
        response.end("<script>document.title='executed'</script>");
        return;
      }
      if (request.url === '/broken') {
        response.writeHead(500);
        response.end('boom');
        return;
      }
      if (request.url === '/denied') {
        response.writeHead(401);
        response.end('not authorized');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          method: request.method,
          body: Buffer.concat(chunks).toString(),
          authorization: request.headers.authorization,
          secretEcho: 'private-fixture-session',
          accessToken: 'newly-minted-secret',
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No API port');
    origin = `http://127.0.0.1:${address.port}`;
    driver = new ApiDriver({
      url: origin,
      headers: { Authorization: 'Bearer private-fixture-session' },
      methods: ['GET', 'POST'],
      timeoutMs: 100,
      viewport: { width: 900, height: 600 },
      redact: (text) => text.replaceAll('private-fixture-session', '{{SESSION}}'),
    });
    await driver.connect();
  }, 15000);
  afterAll(async () => {
    await driver?.close();
    server?.closeAllConnections();
    collector?.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => collector.close(() => resolve())),
    ]);
  });

  it('sends allowed writes and exposes sanitized response evidence', async () => {
    const result = await driver.act({
      kind: 'request',
      method: 'POST',
      url: '/echo',
      body: '{"message":"hello"}',
      headers: { authorization: 'Bearer second-session' },
    });
    expect(result.ok).toBe(true);
    const observation = await driver.observe();
    expect(observation.http?.status).toBe(200);
    expect(observation.http?.body).toContain('hello');
    expect(observation.http?.body).not.toContain('private-fixture-session');
    expect(observation.http?.body).not.toContain('newly-minted-secret');
    expect(observation.http?.body).not.toContain('second-session');
    expect(observation.platform).toBe('api');
    expect(observation.screenshot.length).toBeGreaterThan(100);
  });
  it('captures fresh response ids for replay and refuses missing or credential fields', async () => {
    const first = await driver.act({
      kind: 'request',
      method: 'POST',
      url: '/entities',
      capture: { RESPONSE_ENTITY: '/result/id' },
    });
    const second = await driver.act({
      kind: 'request',
      method: 'POST',
      url: '/entities',
      capture: { RESPONSE_ENTITY: '/result/id' },
    });
    expect(first.captures).toEqual({ RESPONSE_ENTITY: 'entity-1' });
    expect(second.captures).toEqual({ RESPONSE_ENTITY: 'entity-2' });
    expect(
      (
        await driver.act({
          kind: 'request',
          method: 'GET',
          url: '/entities',
          capture: { RESPONSE_TOKEN: '/accessToken' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await driver.act({
          kind: 'request',
          method: 'GET',
          url: '/entities',
          capture: { RESPONSE_MISSING: '/missing' },
        })
      ).error,
    ).toContain('did not resolve');
    expect(
      (await driver.act({ kind: 'request', method: 'GET', url: '/entities', capture: { SESSION_TOKEN: '/result/id' } }))
        .ok,
    ).toBe(false);
  });
  it('blocks disallowed methods and credentials sent to a different origin', async () => {
    expect((await driver.act({ kind: 'request', method: 'DELETE', url: '/echo' })).ok).toBe(false);
    expect((await driver.act({ kind: 'request', method: 'GET', url: otherOrigin })).ok).toBe(false);
    expect(
      (await driver.act({ kind: 'request', method: 'GET', url: origin.replace('http://', 'http://user:password@') }))
        .ok,
    ).toBe(false);
    expect((await driver.act({ kind: 'request', method: 'GET', url: '/redirect' })).ok).toBe(true);
    expect((await driver.observe()).http?.status).toBe(302);
    expect(leaks).toBe(0);
  });
  it('treats response errors as evidence and never executes response HTML', async () => {
    expect((await driver.act({ kind: 'request', method: 'GET', url: '/denied' })).ok).toBe(true);
    expect((await driver.observe()).http?.status).toBe(401);
    await driver.act({ kind: 'request', method: 'GET', url: '/html' });
    const observation = await driver.observe();
    expect(observation.http?.body).toContain('<script>');
    expect(observation.title).not.toBe('executed');
  });
  it('reports server failures once as failed requests, and client errors never', async () => {
    await driver.observe();
    await driver.act({ kind: 'request', method: 'GET', url: '/denied' });
    expect((await driver.observe()).networkErrors).toEqual([]);
    expect((await driver.act({ kind: 'request', method: 'GET', url: '/broken' })).ok).toBe(true);
    await driver.act({ kind: 'request', method: 'GET', url: '/slow' });
    const failed = (await driver.observe()).networkErrors ?? [];
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatch(/^GET http:\/\/127\.0\.0\.1:\d+\/broken → 500$/);
    expect(failed[1]).toMatch(/\/slow → TimeoutError$/);
    expect((await driver.observe()).networkErrors).toEqual([]);
  });
  it('records each request and response as a terminal cast, with credentials redacted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-api-cast-'));
    try {
      await driver.startRecording();
      await driver.act({
        kind: 'request',
        method: 'POST',
        url: '/echo?page=2',
        body: '{"message":"hello","session":"private-fixture-session"}',
        headers: { authorization: 'Bearer second-session' },
      });
      await driver.act({ kind: 'request', method: 'GET', url: '/denied' });
      await driver.act({ kind: 'request', method: 'GET', url: '/slow' });
      const file = await driver.stopRecording(join(dir, 'head'));
      expect(file).toBe(join(dir, 'head.cast'));
      const text = (await readCast(file)).events.map(([, output]) => output).join('');
      expect(text).toContain('POST /echo?page=2');
      expect(text).toContain('hello');
      expect(text).toContain('200');
      expect(text).toContain('GET /denied');
      expect(text).toContain('401');
      expect(text).toContain('not authorized');
      expect(text).toContain('GET /slow');
      expect(text).toContain('TimeoutError');
      expect(text).toContain('{{SESSION}}');
      for (const secret of ['private-fixture-session', 'newly-minted-secret', 'second-session'])
        expect(text).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('fails explicitly on timeouts and oversized response evidence', async () => {
    expect((await driver.act({ kind: 'request', method: 'GET', url: '/slow' })).ok).toBe(false);
    expect((await driver.act({ kind: 'request', method: 'GET', url: '/big' })).error).toContain('exceeds 1 MiB');
  });
});
