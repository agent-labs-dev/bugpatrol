import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixtureApi, fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import { buildContract, type Contract, loadSpec, requestPolicy } from '@bugpatrol/contract';
import { formatHttpExchange, type HttpExchange, type HttpMethod } from '@bugpatrol/core';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiDriver } from './api.js';
import { Pacer } from './api-pacer.js';
import { readCast } from './cast.js';

const ALLOWED = ['content-type', 'location', 'retry-after', 'allow', 'www-authenticate', 'x-request-id'];

/** The fixture contract, with its login: the spec leaves it out, and a URL outside the contract can only read. */
async function fixtureContract(): Promise<Contract> {
  const doc = await loadSpec({ file: fixtureSpecPath });
  doc.paths['/auth/login'] = { post: { operationId: 'login', responses: {} } };
  return buildContract(doc, {});
}

describe('API driver against the fixture API', () => {
  let fixture: FixtureApi;
  /** Another origin: credentials must never reach it, and its redirect must not be followed. */
  let elsewhere: Server;
  let elsewhereOrigin: string;
  let leaks = 0;
  let driver: ApiDriver;
  let contract: Contract;
  const redact = (text: string) => text.replaceAll('fixture-token-a', '{{TOKEN}}');
  const apiDriver = (
    url: string,
    options: { methods?: HttpMethod[]; deny?: string[]; pacer?: Pacer; headers?: Record<string, string> } = {},
  ) =>
    new ApiDriver({
      url,
      credentials: { self: options.headers ?? {} },
      policy: requestPolicy(contract, {
        url,
        methods: options.methods ?? ['GET'],
        deny: options.deny ?? [],
        disposable: false,
      }),
      pacer: options.pacer ?? new Pacer({ perMinute: 60_000 }),
      timeoutMs: 1000,
      redact,
    });
  const exchange = async (): Promise<HttpExchange | undefined> => {
    const { capture } = await driver.observe();
    if (capture.kind !== 'http') throw new Error('The api driver observed an image');
    return capture.exchange;
  };
  const launch = vi.spyOn(chromium, 'launch');

  beforeAll(async () => {
    fixture = await startFixtureApi({ perSecond: 1000 });
    elsewhere = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `${fixture.url}/health` }).end();
        return;
      }
      leaks++;
      response.end('unexpected');
    });
    elsewhere.listen(0, '127.0.0.1');
    await once(elsewhere, 'listening');
    const address = elsewhere.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    elsewhereOrigin = `http://127.0.0.1:${address.port}`;
    contract = await fixtureContract();
    driver = new ApiDriver({
      url: fixture.url,
      credentials: {
        self: { Authorization: 'Bearer fixture-token-a', 'X-Workspace-Id': 'ws-a' },
        other: { Authorization: 'Bearer fixture-token-b', 'X-Workspace-Id': 'ws-b' },
      },
      policy: requestPolicy(contract, { url: fixture.url, methods: ['GET', 'POST'], deny: [], disposable: false }),
      pacer: new Pacer({ perMinute: 60_000 }),
      timeoutMs: 300,
      redact,
    });
    await driver.connect();
  });
  afterAll(async () => {
    await driver?.close();
    await fixture?.close();
    elsewhere?.closeAllConnections();
    await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
  });

  it('starts no browser', async () => {
    await driver.act({ kind: 'request', method: 'GET', url: '/health' });
    const observation = await driver.observe();
    expect(observation.platform).toBe('api');
    expect(observation.capture).toMatchObject({ kind: 'http', exchange: { response: { status: 200 } } });
    expect(launch).not.toHaveBeenCalled();
  });

  it('sends allowed writes and exposes redacted response evidence', async () => {
    const login = await driver.act({ kind: 'request', method: 'POST', url: '/auth/login', body: '{"user":"a"}' });
    expect(login.ok).toBe(true);
    const evidence = await exchange();
    expect(evidence?.response?.status).toBe(200);
    expect(evidence?.response?.body).toContain('ws-a');
    expect(evidence?.response?.body).toContain('[redacted]');
    expect(formatHttpExchange(evidence!)).not.toContain('fixture-token-a');

    const created = await driver.act({
      kind: 'request',
      method: 'POST',
      url: '/items',
      body: '{"name":"hello"}',
      headers: { authorization: 'Bearer fixture-token-b', 'X-Workspace-Id': 'ws-b' },
    });
    expect(created.ok).toBe(true);
    const write = await exchange();
    expect(write?.response).toMatchObject({ status: 201, contentType: 'application/json' });
    expect(write?.response?.body).toContain('"owner": "b"');
    expect(write?.request).toMatchObject({
      method: 'POST',
      path: '/items',
      headers: { authorization: '[redacted]', 'x-workspace-id': 'ws-b' },
      body: '{\n  "name": "hello"\n}',
    });
    expect(formatHttpExchange(write!)).not.toContain('fixture-token');
  });

  it('sends each credential set, and none for as: none', async () => {
    const owners = async (as: 'self' | 'other' | 'none') => {
      await driver.act({ kind: 'request', method: 'GET', url: '/items', as });
      const raw = driver.lastRaw();
      const items = (raw?.json as { result?: { owner: string }[] } | undefined)?.result;
      return items ? [...new Set(items.map((item) => item.owner))] : raw?.status;
    };
    expect(await owners('self')).toEqual(['a']);
    expect(await owners('other')).toEqual(['b']);
    expect(await owners('none')).toBe(401);
  });

  it('gives the raw response before redaction for in-process checks', async () => {
    await driver.act({ kind: 'request', method: 'POST', url: '/auth/login', body: '{"user":"a"}' });
    expect(driver.lastRaw()).toMatchObject({
      status: 200,
      headers: { 'content-type': 'application/json' },
      json: { result: { token: 'fixture-token-a', workspaceId: 'ws-a' } },
    });
    expect(JSON.stringify(await driver.observe())).not.toContain('fixture-token-a');
  });

  it('redacts headers outside the allowlist', async () => {
    await driver.act({ kind: 'request', method: 'GET', url: '/items' });
    const headers = (await exchange())?.response?.headers ?? {};
    expect(headers['content-type']).toBe('application/json');
    expect(Object.keys(headers).every((name) => ALLOWED.includes(name))).toBe(true);
    expect(headers).not.toHaveProperty('date');
    expect(headers).not.toHaveProperty('content-length');
  });

  it('429 waits Retry-After and is not evidence', async () => {
    const limited = await startFixtureApi({ perSecond: 1 });
    const blocked = await startFixtureApi({ perSecond: 0 });
    try {
      const paced = apiDriver(limited.url);
      expect((await paced.act({ kind: 'request', method: 'GET', url: '/health' })).ok).toBe(true);
      const started = Date.now();
      // The fixture answers 429 with Retry-After: 1, and the one more try comes after that second.
      expect(await paced.act({ kind: 'request', method: 'GET', url: '/health' })).toMatchObject({ ok: true });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(limited.hits()).toHaveLength(3);
      const { capture } = await paced.observe();
      expect(capture.kind === 'http' && capture.exchange?.response?.status).toBe(200);

      const always = apiDriver(blocked.url);
      expect(await always.act({ kind: 'request', method: 'GET', url: '/health' })).toEqual({
        ok: false,
        retryable: true,
        error: 'rate-limited',
      });
      expect(blocked.hits()).toHaveLength(2);
      const after = await always.observe();
      expect(after.capture).toEqual({ kind: 'http' });
      expect(after.networkErrors).toEqual([]);
      expect(always.lastRaw()).toBeUndefined();
    } finally {
      await limited.close();
      await blocked.close();
    }
  });

  it('never hits /admin/wipe', async () => {
    const guarded = apiDriver(fixture.url, { methods: ['GET', 'POST'], deny: ['/admin/**'] });
    for (const url of ['/admin/wipe', '/admin%2Fwipe', '/admin/./wipe', '/items/../admin/wipe'])
      for (const method of ['GET', 'POST'] as const) {
        const result = await guarded.act({ kind: 'request', method, url });
        expect(result.ok).toBe(false);
      }
    expect(fixture.hits().filter((hit) => hit.path.startsWith('/admin'))).toEqual([]);
  });

  it('event-stream is cut and recorded', async () => {
    const started = Date.now();
    expect((await driver.act({ kind: 'request', method: 'GET', url: '/events' })).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    const evidence = (await exchange())!;
    expect(evidence.response).toMatchObject({
      status: 200,
      contentType: 'text/event-stream',
      body: '',
      bytes: 0,
      stream: true,
    });
    expect(formatHttpExchange(evidence)).toContain('[stream cut after 0 bytes]');
  });

  it('pacer spaces requests at 60 per minute', async () => {
    const realTimeout = globalThis.setTimeout;
    /** Real time for the loopback requests; the pacer waits on the fake clock. */
    const io = () => new Promise((resolve) => realTimeout(resolve, 100));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const paced = apiDriver(fixture.url, { pacer: new Pacer() });
      const health = () => fixture.hits().filter((hit) => hit.path === '/health').length;
      const before = health();
      const requests = Promise.all([1, 2, 3].map(() => paced.act({ kind: 'request', method: 'GET', url: '/health' })));
      await io();
      expect(health() - before).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      await io();
      expect(health() - before).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await io();
      expect(health() - before).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      await io();
      expect(health() - before).toBe(3);
      expect((await requests).every((result) => result.ok)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts a request header named api_key', async () => {
    await driver.act({
      kind: 'request',
      method: 'POST',
      url: '/items',
      body: '{"name":"keyed","api_key":"planted-body-key"}',
      headers: { api_key: 'planted-header-key', 'X-Session': 'planted-session' },
    });
    const evidence = (await exchange())!;
    expect(evidence.request.headers).toEqual({ api_key: '[redacted]', 'x-session': '[redacted]' });
    const text = formatHttpExchange(evidence);
    expect(text).toContain('"api_key": "[redacted]"');
    for (const secret of ['planted-header-key', 'planted-body-key', 'planted-session'])
      expect(text).not.toContain(secret);
  });

  it('a body over 1 MiB is tooLarge evidence', async () => {
    const result = await driver.act({ kind: 'request', method: 'GET', url: '/export' });
    expect(result.ok).toBe(true);
    const evidence = (await exchange())!;
    expect(evidence.response).toMatchObject({ status: 200, body: '', tooLarge: true });
    expect(evidence.response!.bytes).toBeGreaterThan(1024 * 1024);
    expect(formatHttpExchange(evidence)).toContain('[body not kept:');
    expect(
      (await driver.act({ kind: 'request', method: 'GET', url: '/export', capture: { RESPONSE_X: '/result' } })).error,
    ).toContain('over 1 MiB');
  });

  it('a failed request clears the last exchange', async () => {
    await driver.act({ kind: 'request', method: 'GET', url: '/health' });
    expect((await exchange())?.response?.status).toBe(200);
    expect(driver.lastRaw()?.status).toBe(200);
    expect((await driver.act({ kind: 'request', method: 'GET', url: '/search?q=A' })).ok).toBe(false);
    const timedOut = await exchange();
    expect(timedOut?.response).toBeUndefined();
    expect(timedOut?.request.path).toBe('/search?q=A');
    expect(timedOut?.error).toContain('TimeoutError');
    expect(driver.lastRaw()).toBeUndefined();

    await driver.act({ kind: 'request', method: 'GET', url: '/health' });
    expect((await driver.act({ kind: 'request', method: 'DELETE', url: '/items/1' })).ok).toBe(false);
    expect(await exchange()).toBeUndefined();
    expect(driver.lastRaw()).toBeUndefined();
  });

  it('captures fresh response ids for replay and refuses missing or credential fields', async () => {
    const create = () =>
      driver.act({
        kind: 'request',
        method: 'POST',
        url: '/items',
        body: '{"name":"fresh"}',
        capture: { RESPONSE_ITEM: '/result/id' },
      });
    const first = Number((await create()).captures?.RESPONSE_ITEM);
    const second = Number((await create()).captures?.RESPONSE_ITEM);
    expect(first).toBeGreaterThan(2);
    expect(second).toBe(first + 1);
    const login = (capture: Record<string, string>) =>
      driver.act({ kind: 'request', method: 'POST', url: '/auth/login', body: '{"user":"a"}', capture });
    expect((await login({ RESPONSE_TOKEN: '/result/token' })).ok).toBe(false);
    expect((await login({ RESPONSE_MISSING: '/missing' })).error).toContain('did not resolve');
    expect((await login({ SESSION_TOKEN: '/result/workspaceId' })).ok).toBe(false);
  });

  it('blocks disallowed methods and credentials sent to a different origin', async () => {
    expect((await driver.act({ kind: 'request', method: 'DELETE', url: '/items/1' })).ok).toBe(false);
    expect((await driver.act({ kind: 'request', method: 'GET', url: elsewhereOrigin })).ok).toBe(false);
    expect(
      (await driver.act({ kind: 'request', method: 'GET', url: fixture.url.replace('http://', 'http://user:pw@') })).ok,
    ).toBe(false);
    const redirected = apiDriver(elsewhereOrigin);
    const health = () => fixture.hits().filter((hit) => hit.path === '/health').length;
    const before = health();
    expect((await redirected.act({ kind: 'request', method: 'GET', url: '/redirect' })).ok).toBe(true);
    const { capture } = await redirected.observe();
    expect(capture.kind === 'http' && capture.exchange?.response).toMatchObject({
      status: 302,
      headers: { location: `${fixture.url}/health` },
    });
    expect(health()).toBe(before);
    expect(leaks).toBe(0);
  });

  it('reports a request with no answer once as a failed request, and a status never', async () => {
    await driver.observe();
    await driver.act({ kind: 'request', method: 'GET', url: '/items/2' });
    expect((await driver.observe()).networkErrors).toEqual([]);
    expect((await driver.act({ kind: 'request', method: 'GET', url: '/items/0' })).ok).toBe(true);
    await driver.act({ kind: 'request', method: 'GET', url: '/search' });
    const failed = (await driver.observe()).networkErrors ?? [];
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/^GET http:\/\/127\.0\.0\.1:\d+\/search → TimeoutError$/);
    expect((await driver.observe()).networkErrors).toEqual([]);
  });

  it('records each request and response as a terminal cast, with credentials redacted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-api-cast-'));
    try {
      await driver.startRecording();
      await driver.act({
        kind: 'request',
        method: 'POST',
        url: '/items?page=2',
        body: '{"name":"hello","note":"fixture-token-a"}',
      });
      await driver.act({ kind: 'request', method: 'GET', url: '/items', headers: { authorization: 'Bearer nope' } });
      await driver.act({ kind: 'request', method: 'GET', url: '/search' });
      const file = await driver.stopRecording(join(dir, 'head'));
      expect(file).toBe(join(dir, 'head.cast'));
      const text = (await readCast(file)).events.map(([, output]) => output).join('');
      expect(text).toContain('POST /items?page=2');
      expect(text).toContain('hello');
      expect(text).toContain('HTTP 201 Created');
      expect(text).toContain('GET /items');
      expect(text).toContain('HTTP 401 Unauthorized');
      expect(text).toContain('A valid bearer token is required.');
      expect(text).toContain('GET /search');
      expect(text).toContain('TimeoutError');
      expect(text).toContain('{{TOKEN}}');
      for (const secret of ['fixture-token-a', 'nope']) expect(text).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
