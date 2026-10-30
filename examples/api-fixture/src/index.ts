// A deterministic backend with planted bugs. Bugpatrol tests its api platform
// against it: each planted bug must become a finding, and each control must not.
//
// Planted bugs:
//   1. GET /items/0 returns 500.
//   2. GET /items returns an undeclared `internal_note` field.
//   3. User B reads an item of user A and gets 403, where 404 hides the item.
//   4. A second DELETE /items/{id} returns 500.
//   5. POST /items with a bad body returns 200, not the declared 422.
//   6. GET /health returns 200 with `db: "down"`.
//   7. GET /items/{id} declares only 200, and a missing id returns 404.

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

/** The OpenAPI 3.1 contract of the fixture. Its `servers` value is production, which Bugpatrol must ignore. */
export const fixtureSpecPath = fileURLToPath(new URL('../openapi.json', import.meta.url));

export interface Hit {
  method: string;
  /** The path without the query string. */
  path: string;
}

export interface FixtureApiOptions {
  /** 0 (the default) picks a free port. */
  port?: number;
  /** The commit that `GET /version` reports. */
  commit?: string;
  /** More requests than this in one second get 429. */
  perSecond?: number;
}

export interface FixtureApi {
  url: string;
  hits(): Hit[];
  setCommit(sha: string): void;
  /** Overrides the commits of `GET /version/fleet`, which otherwise reports the one commit. */
  setFleet(shas: string[]): void;
  /** The next request to this method and path gets 500, and later requests do not. */
  failOnce(method: string, path: string): void;
  close(): Promise<void>;
}

interface Item {
  id: string;
  name: string;
  owner: string;
  workspace: string;
}

const USERS: Record<string, { token: string; workspaceId: string }> = {
  a: { token: 'fixture-token-a', workspaceId: 'ws-a' },
  b: { token: 'fixture-token-b', workspaceId: 'ws-b' },
};

const SEED: Item[] = [
  { id: '1', name: 'Alpha', owner: 'a', workspace: 'ws-a' },
  { id: '2', name: 'Beta', owner: 'b', workspace: 'ws-b' },
];

const MiB = 1024 * 1024;
const spec = readFileSync(fixtureSpecPath, 'utf8');
let bigSpec: string | undefined;

/** The fixture spec, padded with unused component schemas to a little over 2 MiB. */
function paddedSpec(): string {
  if (bigSpec) return bigSpec;
  const parsed = JSON.parse(spec);
  const padding = { type: 'object', description: 'padding '.repeat(128) };
  for (let size = JSON.stringify(parsed).length, index = 0; size < 2 * MiB; index++) {
    const key = `Padding${index}`;
    parsed.components.schemas[key] = padding;
    // The key, its quotes, a colon, the value, and a comma.
    size += key.length + JSON.stringify(padding).length + 4;
  }
  bigSpec = JSON.stringify(parsed);
  return bigSpec;
}

export async function startFixtureApi(options: FixtureApiOptions = {}): Promise<FixtureApi> {
  const perSecond = options.perSecond ?? 20;
  const hits: Hit[] = [];
  const recent: number[] = [];
  const failures = new Set<string>();
  let commit = options.commit ?? '0000000';
  let fleet: string[] | undefined;
  let items = SEED.map((item) => ({ ...item }));
  let nextId = SEED.length + 1;
  const deleted = new Set<string>();

  const send = (response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (body === undefined) {
      response.writeHead(status, headers).end();
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  };
  const fail = (response: ServerResponse, status: number, code: string, message: string) =>
    send(response, status, { error: { code, message } });

  const readJson = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return undefined;
    }
  };
  const nameOf = (body: unknown): string | undefined => {
    const name = (body as { name?: unknown } | undefined)?.name;
    return typeof name === 'string' && name ? name : undefined;
  };

  /** The user of the bearer token, when the workspace header matches that user. */
  const authenticate = (request: IncomingMessage, response: ServerResponse): string | undefined => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const user = Object.keys(USERS).find((name) => USERS[name]!.token === token);
    if (!user) {
      fail(response, 401, 'unauthorized', 'A valid bearer token is required.');
      return undefined;
    }
    if (request.headers['x-workspace-id'] !== USERS[user]!.workspaceId) {
      fail(response, 409, 'no_workspace', 'X-Workspace-Id must name a workspace of the user.');
      return undefined;
    }
    return user;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const path = url.pathname;
    hits.push({ method, path });

    const now = Date.now();
    while (recent.length && recent[0]! <= now - 1000) recent.shift();
    if (recent.length >= perSecond) {
      return send(
        response,
        429,
        { error: { code: 'rate_limited', message: 'Too many requests.' } },
        { 'retry-after': '1' },
      );
    }
    recent.push(now);

    const failure = `${method} ${path}`;
    if (failures.delete(failure)) return fail(response, 500, 'internal', 'A failure that does not repeat.');

    const route = `${method} ${path.replace(/^\/items\/[^/]+$/, '/items/{id}')}`;
    const id = path.split('/')[2] ?? '';
    switch (route) {
      case 'GET /openapi.json':
        return response.writeHead(200, { 'content-type': 'application/json' }).end(spec);
      case 'GET /openapi-big.json':
        return response.writeHead(200, { 'content-type': 'application/json' }).end(paddedSpec());
      case 'GET /health':
        return send(response, 200, { status: 'ok', db: 'down' });
      case 'GET /version':
        return send(response, 200, { result: { commit } });
      case 'GET /version/fleet':
        return send(response, 200, { result: (fleet ?? [commit]).map((sha) => ({ commit: sha })) });
      case 'GET /events': {
        // Declared as application/json, but it streams and never ends.
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let tick = 0;
        const write = () => response.write(`data: ${JSON.stringify({ tick: tick++ })}\n\n`);
        write();
        const timer = setInterval(write, 1000);
        response.on('close', () => clearInterval(timer));
        return;
      }
      case 'POST /auth/login': {
        const user = (await readJson(request)) as { user?: unknown } | undefined;
        const account = typeof user?.user === 'string' ? USERS[user.user] : undefined;
        if (!account) return fail(response, 401, 'unknown_user', 'The user must be "a" or "b".');
        return send(response, 200, { result: account });
      }
    }

    const user = authenticate(request, response);
    if (!user) return;
    const visible = () => items.filter((item) => item.owner === user);
    switch (route) {
      case 'GET /items':
        return send(response, 200, {
          result: visible().map((item) => ({ ...item, internal_note: `seeded by ${user}` })),
        });
      case 'POST /items': {
        const name = nameOf(await readJson(request));
        if (!name) return send(response, 200, { error: { code: 'invalid_body', message: 'A name is required.' } });
        const item = { id: String(nextId++), name, owner: user, workspace: USERS[user]!.workspaceId };
        items.push(item);
        return send(response, 201, { result: item });
      }
      case 'GET /items/{id}': {
        if (id === '0') return fail(response, 500, 'internal', 'Division by zero.');
        const item = items.find((candidate) => candidate.id === id);
        if (!item) return fail(response, 404, 'not_found', 'No such item.');
        if (item.owner !== user) return fail(response, 403, 'forbidden', 'This item belongs to another user.');
        return send(response, 200, { result: item });
      }
      case 'PATCH /items/{id}': {
        const item = visible().find((candidate) => candidate.id === id);
        if (!item) return fail(response, 404, 'not_found', 'No such item.');
        const name = nameOf(await readJson(request));
        if (!name) return fail(response, 422, 'invalid_body', 'A name is required.');
        item.name = name;
        return send(response, 200, { result: item });
      }
      case 'DELETE /items/{id}': {
        if (deleted.has(id)) return fail(response, 500, 'internal', 'The item row is already gone.');
        const item = visible().find((candidate) => candidate.id === id);
        if (!item) return fail(response, 404, 'not_found', 'No such item.');
        items = items.filter((candidate) => candidate !== item);
        deleted.add(id);
        return send(response, 204);
      }
      case 'GET /search': {
        const query = url.searchParams.get('q') ?? '';
        await new Promise((resolve) => setTimeout(resolve, 800));
        return send(response, 200, { result: visible().filter((item) => item.name.includes(query)) });
      }
      case 'GET /export':
        return send(response, 200, { result: 'x'.repeat(2 * MiB) });
      case 'POST /notify':
        return send(response, 202, { result: { queued: true } });
      case 'POST /admin/wipe':
        items = SEED.map((item) => ({ ...item }));
        nextId = SEED.length + 1;
        deleted.clear();
        return send(response, 204);
    }
    fail(response, 404, 'not_found', `No route for ${method} ${path}.`);
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) fail(response, 500, 'internal', String(error));
    });
  });
  server.listen(options.port ?? 0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fixture API has no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits.map((hit) => ({ ...hit })),
    setCommit: (sha) => {
      commit = sha;
    },
    setFleet: (shas) => {
      fleet = [...shas];
    },
    failOnce: (method, path) => {
      failures.add(`${method.toUpperCase()} ${path}`);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
