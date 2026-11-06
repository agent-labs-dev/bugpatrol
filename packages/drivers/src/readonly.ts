import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import type { BrowserContext } from 'playwright';

/** The methods that read-only mode lets reach the backend. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export type ReadOnlyOptions = {
  log: WriteLog;
  /** `block` refuses every WebSocket; `pass` lets it through, less the client frames that `dropFrames` matches. */
  websockets: 'block' | 'pass';
  dropFrames: RegExp[];
};

/**
 * A write that read-only mode kept from the backend. `method` is `WEBSOCKET` for a refused socket, `FRAME` for a
 * dropped frame and `WORKER` for a refused worker.
 */
export type BlockedWrite = { at: string; method: string; url: string };

/** The URL with each query value hidden, since a query can carry a token. */
export function redactQuery(url: string): string {
  if (!URL.canParse(url)) return url.replace(/\?.*$/s, '?[redacted]');
  const parsed = new URL(url);
  if (!parsed.search) return `${parsed.origin}${parsed.pathname}`;
  const names = [...new Set(parsed.searchParams.keys())];
  return `${parsed.origin}${parsed.pathname}?${names.map((name) => `${name}=[redacted]`).join('&')}`;
}

/** Every write that read-only mode blocked in a run. */
export class WriteLog {
  private readonly blocked: BlockedWrite[] = [];
  private drained = 0;

  record(method: string, url: string): void {
    this.blocked.push({ at: new Date().toISOString(), method, url: redactQuery(url) });
  }

  get count(): number {
    return this.blocked.length;
  }

  /** One line for each write blocked since the last call. */
  drain(): string[] {
    const lines = this.blocked.slice(this.drained).map(({ at, method, url }) => `${method} ${url} at ${at}`);
    this.drained = this.blocked.length;
    return lines;
  }
}

const matches = (patterns: RegExp[], data: string | Buffer) => {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  return patterns.some((pattern) => pattern.test(text));
};

/**
 * Holds back the writes of a browser: every request but a read is aborted,
 * and WebSockets are refused or have their matching client frames dropped.
 * Routes apply to pages and requests made after this call; a service worker's
 * own requests bypass them, so a web context blocks service workers. WebSocket
 * routes do not reach a dedicated or shared worker, so while a WebSocket rule
 * applies, pages cannot start one.
 */
export async function guardBrowser(context: BrowserContext, options: ReadOnlyOptions): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (SAFE.has(request.method())) return route.continue();
    options.log.record(request.method(), request.url());
    await route.abort('blockedbyclient');
  });
  if (options.websockets === 'pass' && !options.dropFrames.length) return;
  await context.exposeBinding('__bugpatrolBlockedWorker', (_source, url: string) => options.log.record('WORKER', url));
  await context.addInitScript(refuseWorkers);
  await context.routeWebSocket(/.*/, async (socket) => {
    if (options.websockets === 'block') {
      options.log.record('WEBSOCKET', socket.url());
      await socket.close({ code: 1008, reason: 'Bugpatrol read-only mode' });
      return;
    }
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (matches(options.dropFrames, message)) options.log.record('FRAME', socket.url());
      else server.send(message);
    });
  });
}

/** Runs in each frame before its scripts: replaces the worker constructors with ones that log and throw. */
function refuseWorkers() {
  const scope = globalThis as unknown as Record<string, unknown> & { __bugpatrolBlockedWorker?: (url: string) => void };
  for (const name of ['Worker', 'SharedWorker']) {
    if (typeof scope[name] !== 'function') continue;
    const refused = class {
      constructor(url: string | URL) {
        scope.__bugpatrolBlockedWorker?.(new URL(String(url), location.href).href);
        throw new DOMException('Bugpatrol read-only mode blocks workers', 'SecurityError');
      }
    };
    Object.defineProperty(scope, name, { value: refused, writable: false, configurable: false });
  }
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function forwardHeaders(request: IncomingMessage, host: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { host };
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
  }
  return headers;
}

/**
 * Splits the client side of a WebSocket into frames, holds each data message
 * until its final frame, and keeps back each whole message that matches. A
 * client frame is always masked. Control frames always pass. The proxy refuses compression, so the payload is the
 * message as the app wrote it.
 */
export function frameFilter(patterns: RegExp[], onDrop: () => void): (chunk: Buffer) => Buffer {
  let pending = Buffer.alloc(0);
  // The frames of a message whose final frame has not arrived yet.
  let held: Buffer[] = [];
  let payloads: Buffer[] = [];
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const kept: Buffer[] = [];
    while (pending.length >= 2) {
      const opcode = pending[0]! & 0x0f;
      const masked = (pending[1]! & 0x80) !== 0;
      let length = pending[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) break;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) break;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      const start = offset + (masked ? 4 : 0);
      if (pending.length < start + length) break;
      const frame = pending.subarray(0, start + length);
      pending = pending.subarray(start + length);
      if (opcode > 2) {
        kept.push(frame);
        continue;
      }
      const payload = Buffer.from(frame.subarray(start));
      if (masked) for (let index = 0; index < payload.length; index++) payload[index]! ^= frame[offset + (index % 4)]!;
      held.push(frame);
      payloads.push(payload);
      if ((frame[0]! & 0x80) === 0) continue;
      if (matches(patterns, Buffer.concat(payloads))) onDrop();
      else kept.push(...held);
      held = [];
      payloads = [];
    }
    return Buffer.concat(kept);
  };
}

export type ReadOnlyProxy = { url: string; close(): Promise<void> };

/**
 * A loopback reverse proxy to `upstream` for an app that talks to its
 * backend itself. Reads go through; any other method gets a 405 and is
 * logged. A WebSocket upgrade is refused, or tunnelled with the matching
 * client frames dropped.
 */
export async function startReadOnlyProxy(upstream: string, options: ReadOnlyOptions): Promise<ReadOnlyProxy> {
  const base = new URL(upstream);
  const secure = base.protocol === 'https:' || base.protocol === 'wss:';
  const port = Number(base.port) || (secure ? 443 : 80);
  const prefix = base.pathname.replace(/\/$/, '');
  const target = (path = '/') => `${base.protocol}//${base.host}${prefix}${path}`;

  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    if (!SAFE.has(method)) {
      options.log.record(method, target(request.url));
      request.resume();
      response.writeHead(405, { allow: 'GET, HEAD, OPTIONS', 'content-type': 'text/plain' });
      response.end('Bugpatrol read-only mode blocked this write.\n');
      return;
    }
    const outgoing = (secure ? httpsRequest : httpRequest)(
      target(request.url),
      { method, headers: forwardHeaders(request, base.host) },
      (answer) => {
        const headers = Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
        response.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(response);
      },
    );
    outgoing.on('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(`Bugpatrol read-only proxy: ${error.message}\n`);
    });
    request.pipe(outgoing);
  });

  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };
  server.on('upgrade', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    if (options.websockets === 'block') {
      options.log.record('WEBSOCKET', target(request.url));
      client.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const upstreamSocket: Socket = secure
      ? tlsConnect({ host: base.hostname, port, servername: base.hostname })
      : netConnect({ host: base.hostname, port });
    track(upstreamSocket);
    upstreamSocket.on('close', () => client.destroy());
    client.on('close', () => upstreamSocket.destroy());
    const lines = [`GET ${prefix}${request.url ?? '/'} HTTP/1.1`, `host: ${base.host}`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]!;
      const lower = name.toLowerCase();
      if (lower === 'host') continue;
      // A compressed frame hides its text from dropFrames.
      if (lower === 'sec-websocket-extensions' && options.dropFrames.length) continue;
      lines.push(`${name}: ${request.rawHeaders[index + 1]}`);
    }
    upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
    const filter = options.dropFrames.length
      ? frameFilter(options.dropFrames, () => options.log.record('FRAME', target(request.url)))
      : undefined;
    const send = (data: Buffer) => {
      const kept = filter ? filter(data) : data;
      if (kept.length) upstreamSocket.write(kept);
    };
    if (head.length) send(head);
    client.on('data', send);
    upstreamSocket.pipe(client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The read-only proxy did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
