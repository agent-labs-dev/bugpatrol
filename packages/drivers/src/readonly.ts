import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import type { BrowserContext, CDPSession, Page } from 'playwright';

/** The methods that read-only mode lets reach the backend. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * What a driver holds back from the backend. Without `allowWrites`, only
 * reads go out (`app.readOnly`). `deny` names the `app.connect.deny` glob
 * that a request matches; a matching request never goes out, read or write.
 */
export type ReadOnlyOptions = {
  log: WriteLog;
  /** Writes go out, less those that `deny` matches: `app.connect.deny` without read-only mode. */
  allowWrites?: true;
  deny?: (method: string, url: string) => string | undefined;
  /** `block` refuses every WebSocket; `pass` lets it through, less the client frames that `dropFrames` matches. */
  websockets: 'block' | 'pass';
  dropFrames: RegExp[];
};

/**
 * A request that Bugpatrol kept from the backend. `method` is `WEBSOCKET` for a refused socket, `FRAME` for a
 * dropped frame and `WORKER` for a refused worker. `rule` is the `app.connect.deny` glob it matched, if any.
 */
export type BlockedWrite = { at: string; method: string; url: string; rule?: string };

/** The URL with each query value hidden, since a query can carry a token. */
export function redactQuery(url: string): string {
  if (!URL.canParse(url)) return url.replace(/\?.*$/s, '?[redacted]');
  const parsed = new URL(url);
  const names = [...new Set(parsed.searchParams.keys())];
  // Built from the href, not origin + pathname: for a `blob:` URL the pathname already holds the inner origin.
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  if (!names.length) return parsed.href;
  return `${parsed.href}?${names.map((name) => `${name}=[redacted]`).join('&')}`;
}

/** Every request that read-only mode or `app.connect.deny` blocked in a run. */
export class WriteLog {
  private readonly blocked: BlockedWrite[] = [];
  private drained = 0;

  record(method: string, url: string, rule?: string): void {
    this.blocked.push({ at: new Date().toISOString(), method, url: redactQuery(url), ...(rule ? { rule } : {}) });
  }

  get count(): number {
    return this.blocked.length;
  }

  /** One line for each request blocked since the last call. */
  drain(): string[] {
    const lines = this.blocked
      .slice(this.drained)
      .map(({ at, method, url, rule }) => `${method} ${url} at ${at}${rule ? `: app.connect.deny has ${rule}` : ''}`);
    this.drained = this.blocked.length;
    return lines;
  }
}

const matches = (patterns: RegExp[], data: string | Buffer) => {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  return patterns.some((pattern) => pattern.test(text));
};

/**
 * Holds back the writes of a browser: every request that `deny` matches is
 * aborted, and so is every request but a read unless `allowWrites` is set.
 * A WebSocket whose handshake `deny` matches is refused; the others are
 * refused or have their matching client frames dropped.
 * Routes apply to pages and requests made after this call; a service worker's
 * own requests bypass them, so a web context blocks service workers. WebSocket
 * routes do not reach a dedicated or shared worker, so while a deny list or a
 * read-only WebSocket rule applies, pages cannot start one. A route does not see
 * the hops of a redirect either, so with a deny list each page, and each frame of it that runs in a process of its
 * own, also watches the redirects it receives, from before its first request, and fails one whose next request
 * `deny` matches.
 */
export async function guardBrowser(context: BrowserContext, options: ReadOnlyOptions): Promise<void> {
  const watchRedirects = options.deny && redirectGuard(context, options.log, options.deny);
  if (watchRedirects) {
    // A watch started while a request is in flight misses that request, so each page is watched as soon as it
    // exists, and again before any request that finds it unwatched.
    context.on('page', (page) => void watchRedirects(page).catch(() => undefined));
    await Promise.all(context.pages().map(watchRedirects));
  }
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (watchRedirects) {
      // No page exists yet for the first navigation of a popup, and a worker's request has no frame: a worker is
      // refused whenever a deny list applies.
      const page = (() => {
        try {
          return request.frame().page();
        } catch {
          return undefined;
        }
      })();
      if (page) await watchRedirects(page).catch(() => undefined);
    }
    const rule = options.deny?.(request.method(), request.url());
    if (!rule && (options.allowWrites || SAFE.has(request.method()))) return route.continue();
    options.log.record(request.method(), request.url(), rule);
    await route.abort('blockedbyclient');
  });
  const readOnlySockets = options.websockets === 'block' || options.dropFrames.length > 0;
  if (!readOnlySockets && !options.deny) return;
  await context.exposeBinding('__bugpatrolBlockedWorker', (_source, url: string) => options.log.record('WORKER', url));
  await context.addInitScript(refuseWorkers);
  await context.routeWebSocket(/.*/, async (socket) => {
    // A WebSocket handshake is a GET.
    const rule = options.deny?.('GET', socket.url());
    if (rule || options.websockets === 'block') {
      options.log.record('WEBSOCKET', socket.url(), rule);
      await socket.close({ code: 1008, reason: rule ? `app.connect.deny has ${rule}` : 'Bugpatrol read-only mode' });
      return;
    }
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (matches(options.dropFrames, message)) options.log.record('FRAME', socket.url());
      else server.send(message);
    });
  });
}

type PausedResponse = {
  requestId: string;
  request: { method: string; url: string };
  responseStatusCode?: number;
  responseHeaders?: { name: string; value: string }[];
};

/** The statuses on which Chromium follows a Location header: any other 3xx is an ordinary response. */
const browserRedirects = new Set([301, 302, 303, 307, 308]);

/** The method of the request that follows a redirect (RFC 9110 15.4). */
function redirectedMethod(method: string, status: number): string {
  if (status === 303) return method === 'HEAD' ? 'HEAD' : 'GET';
  return (status === 301 || status === 302) && method === 'POST' ? 'GET' : method;
}

/** What a watch needs of a CDP target: a page's own session, or a frame target reached through it. */
type Target = {
  send(method: string, params?: object): Promise<unknown>;
  on(method: string, handler: (params: never) => void): void;
};

const sessionTarget = (session: CDPSession): Target => ({
  send: (method, params) => session.send(method as never, params as never),
  on: (method, handler) => session.on(method as never, handler as never),
});

/**
 * A target that `parent` attached to without a flat session: Playwright's CDPSession cannot address a child
 * session, so commands and events travel wrapped in Target messages.
 */
function childTarget(parent: Target, sessionId: string): Target {
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const handlers = new Map<string, ((params: never) => void)[]>();
  parent.on('Target.receivedMessageFromTarget', (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message) as {
      id?: number;
      method?: string;
      params?: never;
      error?: { message: string };
    };
    const waiting = message.id === undefined ? undefined : pending.get(message.id);
    if (waiting) {
      pending.delete(message.id!);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message);
    } else if (message.method) for (const handler of handlers.get(message.method) ?? []) handler(message.params!);
  });
  parent.on('Target.detachedFromTarget', (event: { sessionId: string }) => {
    if (event.sessionId !== sessionId) return;
    for (const waiting of pending.values()) waiting.reject(new Error('The frame target detached'));
    pending.clear();
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        parent
          .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
          .catch((error: Error) => {
            pending.delete(id);
            reject(error);
          });
      }),
    on: (method, handler) => handlers.set(method, [...(handlers.get(method) ?? []), handler]),
  };
}

/**
 * Chromium follows a redirect on its own, so `context.route` never sees the second hop. A page
 * therefore watches its responses, and a redirect to a request that `deny` matches fails before the
 * browser sends it. Under site isolation a cross-site frame is a target of its own whose requests the
 * page's session never sees, so each target also attaches to the frames it starts, holding each until
 * its watch is on. The returned function starts the watch of a page once.
 */
function redirectGuard(
  context: BrowserContext,
  log: WriteLog,
  deny: NonNullable<ReadOnlyOptions['deny']>,
): (page: Page) => Promise<void> {
  const watched = new WeakMap<Page, Promise<void>>();
  /** The request a redirect leads to when `deny` matches it. A Location that is no URL leads nowhere: the browser fails that itself. */
  const deniedRedirect = ({ request, responseStatusCode: status = 0, responseHeaders }: PausedResponse) => {
    const location = responseHeaders?.find(({ name }) => name.toLowerCase() === 'location')?.value;
    if (!location || !browserRedirects.has(status) || !URL.canParse(location, request.url)) return undefined;
    const url = new URL(location, request.url).href;
    const method = redirectedMethod(request.method, status);
    const rule = deny(method, url);
    return rule ? { method, url, rule } : undefined;
  };
  const watch = async (target: Target) => {
    target.on('Fetch.requestPaused', async (event: PausedResponse) => {
      const denied = deniedRedirect(event);
      if (denied) log.record(denied.method, denied.url, denied.rule);
      try {
        // Exactly one answer, whatever the inspection found: a paused request that gets none hangs its navigation.
        if (denied)
          await target.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        else await target.send('Fetch.continueResponse', { requestId: event.requestId });
      } catch {
        // The page closed, or the request ended, before the answer.
      }
    });
    target.on(
      'Target.attachedToTarget',
      async ({ sessionId, targetInfo }: { sessionId: string; targetInfo: { type: string } }) => {
        const child = childTarget(target, sessionId);
        try {
          if (targetInfo.type === 'iframe') await watch(child);
        } catch {
          // The frame went away before its watch was on.
        } finally {
          // Every target the watch attached to waits for this, a worker too: workers are refused in the page.
          await child.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
        }
      },
    );
    await target.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    await target.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  };
  const start = async (page: Page) => watch(sessionTarget(await context.newCDPSession(page)));
  return (page) => {
    let started = watched.get(page);
    if (!started) {
      started = start(page);
      watched.set(page, started);
    }
    return started;
  };
}

/** Runs in each frame before its scripts: replaces the worker constructors with ones that log and throw. */
function refuseWorkers() {
  const scope = globalThis as unknown as Record<string, unknown> & { __bugpatrolBlockedWorker?: (url: string) => void };
  for (const name of ['Worker', 'SharedWorker']) {
    if (typeof scope[name] !== 'function') continue;
    const refused = class {
      constructor(url: string | URL) {
        scope.__bugpatrolBlockedWorker?.(new URL(String(url), location.href).href);
        throw new DOMException('Bugpatrol blocks workers while it holds requests back', 'SecurityError');
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
 * logged, and a request that `deny` matches gets a 403 and is logged. A
 * WebSocket upgrade that `deny` matches is refused; the others are refused,
 * or tunnelled with the matching client frames dropped.
 */
export async function startReadOnlyProxy(upstream: string, options: ReadOnlyOptions): Promise<ReadOnlyProxy> {
  const base = new URL(upstream);
  const secure = base.protocol === 'https:' || base.protocol === 'wss:';
  const port = Number(base.port) || (secure ? 443 : 80);
  const prefix = base.pathname.replace(/\/$/, '');
  const target = (path = '/') => `${base.protocol}//${base.host}${prefix}${path}`;

  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const rule = options.deny?.(method, target(request.url));
    if (rule || (!options.allowWrites && !SAFE.has(method))) {
      options.log.record(method, target(request.url), rule);
      request.resume();
      if (rule) {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end(`Bugpatrol blocked this request: app.connect.deny has ${rule}.\n`);
      } else {
        response.writeHead(405, { allow: 'GET, HEAD, OPTIONS', 'content-type': 'text/plain' });
        response.end('Bugpatrol read-only mode blocked this write.\n');
      }
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
    const rule = options.deny?.('GET', target(request.url));
    if (rule || options.websockets === 'block') {
      options.log.record('WEBSOCKET', target(request.url), rule);
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
