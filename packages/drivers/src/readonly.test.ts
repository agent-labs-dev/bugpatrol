import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { ElectronDriver } from './electron.js';
import { type ReadOnlyProxy, redactQuery, startReadOnlyProxy, WriteLog } from './readonly.js';
import type { Driver } from './types.js';
import { WebDriver } from './web.js';

const servers: Server[] = [];
const proxies: ReadOnlyProxy[] = [];
const sockets: Duplex[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  for (const server of servers.splice(0)) server.closeAllConnections();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** A backend that records each request, and accepts a WebSocket whose text messages it records too. */
async function backend() {
  const seen: string[] = [];
  const messages: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(APP);
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      seen.push(`${request.method} ${request.url} ${request.headers.host}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ method: request.method, url: request.url, body }));
    });
  });
  server.on('upgrade', (request, socket) => {
    sockets.push(socket);
    seen.push(`UPGRADE ${request.url} ${request.headers['sec-websocket-extensions'] ?? ''}`.trim());
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      // Small masked text frames only: enough for the test.
      while (pending.length >= 6 && pending.length >= 6 + (pending[1]! & 0x7f)) {
        const length = pending[1]! & 0x7f;
        const mask = pending.subarray(2, 6);
        const payload = Buffer.from(pending.subarray(6, 6 + length)).map((byte, index) => byte ^ mask[index % 4]!);
        if ((pending[0]! & 0x0f) === 1) messages.push(Buffer.from(payload).toString('utf8'));
        pending = pending.subarray(6 + length);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, messages };
}

/** An app whose buttons write to its backend in each way a page can, and read once. */
const APP = `<title>App</title>
<button onclick="fetch('/api/items?token=t0k', { method: 'POST', body: 'x' }).catch(() => {})">Save</button>
<button onclick="navigator.sendBeacon('/api/beacon', 'x')">Beacon</button>
<button onclick="new WebSocket('ws://' + location.host + '/sync')">Socket</button>
<button onclick="fetch('/api/items').then((r) => r.json()).then((b) => { document.title = 'read ' + b.method })">Load</button>
<form method="post" action="/api/form"><button>Submit</button></form>`;

async function tap(driver: Driver, name: string): Promise<void> {
  const element = (await driver.observe()).elements.find((each) => each.name === name);
  if (!element) throw new Error(`No element named ${name}`);
  expect(await driver.act({ kind: 'tap', ref: element.ref })).toMatchObject({ ok: true });
}

/** Taps the read, then every write, and returns the title the read set and what the driver reported as blocked. */
async function writeEverything(driver: Driver): Promise<{ title?: string; blocked: string[] }> {
  const blocked: string[] = [];
  let title: string | undefined;
  for (const name of ['Load', 'Save', 'Beacon', 'Socket', 'Submit']) {
    await tap(driver, name);
    await new Promise((done) => setTimeout(done, 300));
    const observation = await driver.observe();
    title ??= observation.title;
    blocked.push(...(observation.blockedWrites ?? []));
  }
  return { title, blocked };
}

const readOnly = () => ({ log: new WriteLog(), websockets: 'block' as const, dropFrames: [] });

async function proxy(upstream: string, options: Partial<Parameters<typeof startReadOnlyProxy>[1]> = {}) {
  const log = new WriteLog();
  const started = await startReadOnlyProxy(upstream, { log, websockets: 'block', dropFrames: [], ...options });
  proxies.push(started);
  return { ...started, log };
}

describe('the read-only proxy', () => {
  it('forwards reads to the backend and answers every write itself with a 405', async () => {
    const api = await backend();
    const { url, log } = await proxy(`${api.url}/v1`);
    const read = await fetch(`${url}/items?page=2`);
    expect(await read.json()).toMatchObject({ method: 'GET', url: '/v1/items?page=2' });
    expect((await fetch(`${url}/items`, { method: 'OPTIONS' })).status).toBe(200);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const write = await fetch(`${url}/items/1?token=secret-value`, { method, body: '{"name":"x"}' });
      expect(write.status, method).toBe(405);
    }
    expect(api.seen).toEqual([
      `GET /v1/items?page=2 ${new URL(api.url).host}`,
      `OPTIONS /v1/items ${new URL(api.url).host}`,
    ]);
    expect(log.count).toBe(4);
    const lines = log.drain();
    expect(lines[0]).toMatch(new RegExp(`^POST ${api.url}/v1/items/1\\?token=\\[redacted\\] at \\d{4}-`));
    expect(lines.join('\n')).not.toContain('secret-value');
    expect(log.drain()).toEqual([]);
  });

  it('refuses a WebSocket by default, and logs it', async () => {
    const api = await backend();
    const { url, log } = await proxy(api.url);
    const socket = new WebSocket(`${url.replace('http', 'ws')}/sync`);
    const closed = await new Promise<string>((done) => {
      socket.onopen = () => done('open');
      socket.onerror = () => done('refused');
    });
    expect(closed).toBe('refused');
    expect(api.seen).toEqual([]);
    expect(log.drain()).toEqual([expect.stringMatching(/^WEBSOCKET http:\/\/127\.0\.0\.1:\d+\/sync at /)]);
  });

  it('passes a WebSocket, less the client frames that match dropFrames', async () => {
    const api = await backend();
    const { url, log } = await proxy(api.url, { websockets: 'pass', dropFrames: [/"push"/] });
    const socket = new WebSocket(`${url.replace('http', 'ws')}/sync`);
    await new Promise((done, fail) => {
      socket.onopen = done;
      socket.onerror = fail;
    });
    socket.send('{"type":"pull","id":1}');
    socket.send('{"type":"push","mutation":"task.markRead"}');
    socket.send('{"type":"pull","id":2}');
    for (let tries = 0; tries < 100 && api.messages.length < 2; tries++)
      await new Promise((done) => setTimeout(done, 20));
    socket.close();
    expect(api.messages).toEqual(['{"type":"pull","id":1}', '{"type":"pull","id":2}']);
    // Compression would hide the text of a frame, so the proxy does not offer it.
    expect(api.seen).toEqual(['UPGRADE /sync']);
    expect(log.drain()).toEqual([expect.stringMatching(/^FRAME http:\/\/127\.0\.0\.1:\d+\/sync at /)]);
  });
});

describe('read-only mode in a browser', () => {
  it('web: aborts each write of the page, and lets its reads through', { timeout: 60_000 }, async () => {
    const api = await backend();
    const options = readOnly();
    const driver = new WebDriver({ url: `${api.url}/`, viewport: { width: 640, height: 400 }, readOnly: options });
    cleanups.push(() => driver.close());
    await driver.connect();
    const { title, blocked } = await writeEverything(driver);
    expect(title).toBe('read GET');
    expect(api.seen.filter((line) => !line.startsWith('GET / '))).toEqual([`GET /api/items ${new URL(api.url).host}`]);
    expect(blocked).toEqual([
      expect.stringMatching(new RegExp(`^POST ${api.url}/api/items\\?token=\\[redacted\\] at `)),
      expect.stringMatching(/^POST .*\/api\/beacon at /),
      expect.stringMatching(/^WEBSOCKET ws:.*\/sync at /),
      expect.stringMatching(/^POST .*\/api\/form at /),
    ]);
    expect(driver.writes?.count).toBe(4);
  });

  it('electron: aborts the writes of an app it attached to over CDP', { timeout: 60_000 }, async () => {
    const api = await backend();
    const probe = createNetServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((done) => probe.close(done));
    const profile = await mkdtemp(join(tmpdir(), 'bugpatrol-readonly-'));
    cleanups.push(() => rm(profile, { recursive: true, force: true }));
    const app = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: [`--remote-debugging-port=${port}`, '--disable-gpu'],
    });
    cleanups.push(() => app.close());
    await app.pages()[0]!.goto(`${api.url}/`);
    const driver = new ElectronDriver(`http://127.0.0.1:${port}`, [], undefined, readOnly());
    cleanups.push(() => driver.close());
    await driver.connect();
    // The page was open before Bugpatrol attached: its requests are held back from now on.
    const { title, blocked } = await writeEverything(driver);
    expect(title).toBe('read GET');
    expect(blocked.filter((line) => line.startsWith('POST'))).toHaveLength(3);
    expect(api.seen.filter((line) => /^(POST|PUT|PATCH|DELETE|UPGRADE) /.test(line))).toEqual([]);
    expect(blocked).toContainEqual(expect.stringMatching(/^WEBSOCKET /));
  });
});

describe('redactQuery', () => {
  it('keeps the names of the query and hides each value', () => {
    expect(redactQuery('https://api.test/a/b?token=abc&x=1&x=2')).toBe(
      'https://api.test/a/b?token=[redacted]&x=[redacted]',
    );
    expect(redactQuery('https://api.test/a')).toBe('https://api.test/a');
    expect(redactQuery('not a url?secret=1')).toBe('not a url?[redacted]');
  });
});
