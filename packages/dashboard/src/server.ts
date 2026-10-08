import { createReadStream, existsSync, type FSWatcher, realpathSync, statSync, watch } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, paths } from '@bugpatrol/core';
import { AgentReader } from './agents.js';
import { buildGraph } from './graph.js';
import { ProjectReader } from './project.js';

export type DashboardOptions = {
  root: string;
  configFile?: string;
  port?: number;
  /**
   * Loopback by default and deliberately so: screenshots are of a real
   * application and routinely contain real data. Binding 0.0.0.0 would put
   * them on the network of whatever coffee shop the laptop is in.
   */
  host?: string;
  onReady?: (url: string) => void;
};

export type Dashboard = { url: string; close(): Promise<void> };

const UI_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.cast': 'application/x-asciicast',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** The artifact types the UI renders: screenshots, records, and the recordings of a review. */
const ARTIFACTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.cast', '.json'];

export async function startDashboard(options: DashboardOptions): Promise<Dashboard> {
  const root = resolve(options.root);
  const host = options.host ?? '127.0.0.1';
  const reader = new ProjectReader(root, options.configFile);
  if (options.configFile) loadConfig(root, {}, options.configFile);
  const agents = new AgentReader(root, options.configFile);
  const clients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    handle(req, res, { root, reader, agents, clients }).catch((error) => {
      send(res, 500, { 'content-type': 'application/json' }, JSON.stringify({ error: String(error) }));
    });
  });

  const port = await listen(server, options.port ?? 4311, host);
  const watcher = watchProject(root, () => broadcast(clients, 'changed', { at: Date.now() }));
  const url = `http://${host}:${port}`;
  options.onReady?.(url);

  return {
    url,
    async close() {
      watcher?.close();
      for (const client of clients) client.end();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { root: string; reader: ProjectReader; agents: AgentReader; clients: Set<ServerResponse> },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/api/events') return streamEvents(res, ctx.clients);

  if (path === '/api/overview') return json(res, ctx.agents.overview());
  if (path === '/api/memory') return json(res, ctx.agents.memory());
  if (path === '/api/issues') return json(res, ctx.agents.issues());
  if (path.startsWith('/api/issues/')) {
    const detail = ctx.agents.issue(decodeURIComponent(path.slice('/api/issues/'.length)));
    return detail ? json(res, detail) : json(res, { error: 'no such issue' }, 404);
  }
  if (path === '/api/sessions') {
    const requested = Number(url.searchParams.get('limit') ?? 50);
    const limit = Number.isFinite(requested) ? Math.max(0, Math.min(200, Math.floor(requested))) : 50;
    return json(res, ctx.agents.sessions(limit));
  }
  if (path.startsWith('/api/sessions/')) {
    const detail = ctx.agents.session(decodeURIComponent(path.slice('/api/sessions/'.length)));
    return detail ? json(res, detail) : json(res, { error: 'no such session' }, 404);
  }
  if (path.startsWith('/api/flow/')) {
    const flow = ctx.agents.flow(decodeURIComponent(path.slice('/api/flow/'.length)));
    return flow ? json(res, flow) : json(res, { error: 'no such flow' }, 404);
  }
  if (path === '/api/reviews') return json(res, ctx.agents.reviews());
  if (path.startsWith('/api/reviews/')) {
    const pr = path.slice('/api/reviews/'.length);
    const detail = /^\d+$/.test(pr) ? ctx.agents.review(Number(pr)) : undefined;
    return detail ? json(res, detail) : json(res, { error: 'no such review' }, 404);
  }
  if (path === '/api/appmap') return json(res, ctx.agents.screens());
  if (path === '/api/routines')
    return json(
      res,
      ctx.agents.routines().map((routine) => ({
        id: routine.id,
        description: routine.description,
        steps: routine.steps.length,
        lastReplay: routine.lastReplay,
      })),
    );

  if (path === '/api/state') {
    const runs = ctx.reader.listRuns();
    return json(res, {
      root: ctx.root,
      hasProject: ctx.reader.hasProject(),
      hasConfig: ctx.reader.readConfigRaw() !== undefined,
      hasAppModel: ctx.reader.readAppModel() !== undefined,
      runs,
      live: ctx.reader.readLive() ?? null,
      intents: ctx.reader.readIntents().length,
    });
  }

  if (path === '/api/graph') {
    const requested = url.searchParams.get('run');
    const run = requested ? ctx.reader.readRun(requested) : ctx.reader.latestRun();
    return json(res, buildGraph(ctx.reader.readAppModel(), run, requested ? undefined : ctx.reader.readLive()));
  }

  if (path.startsWith('/api/runs/')) {
    const runId = decodeURIComponent(path.slice('/api/runs/'.length));
    const record = ctx.reader.readRun(runId);
    if (!record) return json(res, { error: 'no such run' }, 404);
    return json(res, {
      run: record.run,
      findings: record.findings,
      trace: record.trace ?? null,
      dir: record.dir,
    });
  }

  if (path === '/api/artifact') {
    const requested = url.searchParams.get('path');
    if (!requested) return json(res, { error: 'path is required' }, 400);
    return serveArtifact(res, ctx.root, requested, req.headers.range);
  }

  return serveUi(res, path);
}

/**
 * Serves a capture artifact, confined to the project's `.bugpatrol` directory.
 *
 * This endpoint takes a filesystem path from a query string, which is exactly
 * the shape of a path-traversal bug. The guard resolves the path first and then
 * checks containment, so `../../../.ssh/id_rsa`, an absolute path, and a
 * symlink pointing outside the tree are all rejected on the resolved form
 * rather than by pattern-matching the input.
 */
export function resolveArtifactPath(root: string, requested: string): string | undefined {
  const candidate = resolve(root, requested);
  if (!existsSync(candidate)) return undefined;

  // resolve() only normalises `..` lexically -- it does not follow symlinks, so
  // a link planted inside .bugpatrol would otherwise pass containment and then
  // read whatever it points at. Both sides are realpath'd so the check is on
  // the actual file, not on the name used to reach it.
  let real: string;
  let allowed: string;
  try {
    real = realpathSync(candidate);
    allowed = realpathSync(paths.dir(root));
  } catch {
    return undefined;
  }

  const rel = relative(allowed, real);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) return undefined;

  const stat = statSync(real);
  if (!stat.isFile()) return undefined;

  // Only artifact types the UI actually renders. A traversal that somehow
  // landed on a readable file still cannot exfiltrate a .env or a key.
  if (!ARTIFACTS.includes(extname(real).toLowerCase())) return undefined;

  return real;
}

/**
 * Serves an artifact whole, or one byte range of it. A browser asks for ranges
 * to seek in a video, and Safari will not play a video without them.
 */
function serveArtifact(res: ServerResponse, root: string, requested: string, range: string | undefined): void {
  const file = resolveArtifactPath(root, requested);
  if (!file) {
    json(res, { error: 'not found' }, 404);
    return;
  }

  const size = statSync(file).size;
  const headers = {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'accept-ranges': 'bytes',
  };
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    createReadStream(file).pipe(res);
    return;
  }
  const bytes = byteRange(range, size);
  if (!bytes) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  const [start, end] = bytes;
  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${size}`,
    'content-length': String(end - start + 1),
  });
  createReadStream(file, { start, end }).pipe(res);
}

/** The first range of a `Range: bytes=...` header, inclusive, or undefined when it misses the file. */
function byteRange(header: string, size: number): [number, number] | undefined {
  const match = header.match(/^bytes=(\d*)-(\d*)/);
  if (!match || (!match[1] && !match[2])) return undefined;
  const [start, end] = match[1]
    ? [Number(match[1]), match[2] ? Math.min(Number(match[2]), size - 1) : size - 1]
    : [Math.max(0, size - Number(match[2])), size - 1];
  return start <= end && start < size ? [start, end] : undefined;
}

function serveUi(res: ServerResponse, path: string): void {
  const name = path === '/' ? 'index.html' : path.replace(/^\//, '');
  const file = resolve(UI_DIR, name);
  if (!file.startsWith(UI_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    // Unknown paths fall through to the app shell so client-side routing works.
    serveUi(res, '/');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'text/plain', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

/**
 * Server-sent events rather than a websocket: the dashboard only ever pushes
 * "something changed, re-fetch", which is one direction and a handful of bytes.
 * A websocket would add a dependency and a handshake for no gain.
 */
function streamEvents(res: ServerResponse, clients: Set<ServerResponse>): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
}

function broadcast(clients: Set<ServerResponse>, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

/**
 * Watches `.bugpatrol/` for run output. Coalesced, because a single run writes
 * several files in quick succession and a client that re-fetches per file
 * would hammer the server for one logical change.
 */
export function watchProject(root: string, onChange: () => void): { close(): void } | undefined {
  const dir = paths.dir(root);
  let timer: NodeJS.Timeout | undefined;
  let probe: NodeJS.Timeout | undefined;
  let fallback: NodeJS.Timeout | undefined;
  let watcher: FSWatcher;
  const changed = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 250);
  };
  const attach = (): void => {
    if (!existsSync(dir)) return;
    try {
      const next = watch(dir, { recursive: true }, changed);
      next.on('error', () => {
        next.close();
        fallback = setInterval(changed, 5000);
      });
      watcher.close();
      watcher = next;
      if (probe) clearInterval(probe);
      changed();
    } catch {
      // Keep the root watcher if recursive watching is unavailable.
    }
  };
  try {
    watcher = existsSync(dir)
      ? watch(dir, { recursive: true }, changed)
      : watch(root, { recursive: false }, () => {
          if (existsSync(dir)) attach();
        });
    watcher.on('error', () => {
      watcher.close();
      fallback = setInterval(changed, 5000);
    });
    if (!existsSync(dir))
      probe = setInterval(() => {
        if (existsSync(dir)) attach();
      }, 100);
    return {
      close() {
        watcher.close();
        if (timer) clearTimeout(timer);
        if (probe) clearInterval(probe);
        if (fallback) clearInterval(fallback);
      },
    };
  } catch {
    // Recursive watch is not available on every platform; the UI also polls.
    return undefined;
  }
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  send(
    res,
    status,
    {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    },
    JSON.stringify(body),
  );
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, headers);
  res.end(body);
}

function listen(server: ReturnType<typeof createServer>, preferred: number, host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const attempt = (port: number, remaining: number): void => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        // A stale dashboard on the default port should not be a hard failure.
        if (error.code === 'EADDRINUSE' && remaining > 0) return attempt(port + 1, remaining - 1);
        reject(error);
      });
      server.listen(port, host, () => resolvePort((server.address() as { port: number }).port));
    };
    attempt(preferred, 20);
  });
}

export { join as joinPath };
