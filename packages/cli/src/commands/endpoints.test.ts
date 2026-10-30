import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Workspace } from '@bugpatrol/agents';
import { parseConfig, paths } from '@bugpatrol/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEndpointsCommand } from './endpoints.js';

const spec = {
  openapi: '3.1.0',
  servers: [{ url: 'https://prod.invalid' }],
  paths: {
    '/items/{id}': { get: { operationId: 'getItem', responses: {} } },
    '/notify': { post: { operationId: 'notify', 'x-bugpatrol-skip': true, responses: {} } },
  },
};

describe('bugpatrol endpoints', () => {
  let root: string;
  let lines: string[];
  const log = (line: string) => {
    lines.push(line);
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bugpatrol-endpoints-cli-'));
    lines = [];
    await writeFile(join(root, 'openapi.json'), JSON.stringify(spec));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('prints the endpoints and the skips, and writes them to the app map', async () => {
    const config = parseConfig({
      version: 1,
      app: { platform: 'api', connect: { url: 'http://127.0.0.1:9', spec: 'openapi.json' } },
    });
    const workspace = new Workspace(root);
    await workspace.upsertScreen({ id: 'home' });

    await runEndpointsCommand([], root, log, config);

    expect(lines).toEqual([
      'GET /items/{id}  getItem  allowed',
      'POST /notify  skipped: x-bugpatrol-skip',
      '\n1 endpoint(s), 1 skipped.',
    ]);
    const map = await workspace.readAppMap();
    expect(map?.screens.map((screen) => screen.id)).toEqual(['home']);
    expect(map?.endpoints?.map((endpoint) => endpoint.key)).toEqual(['GET /items/{id}']);

    await workspace.upsertScreen({ id: 'home' });
    expect((await workspace.readAppMap())?.endpoints).toHaveLength(1);
  });

  it('reads a spec from --spec as JSON, and writes nothing', async () => {
    await runEndpointsCommand(['--spec', join(root, 'openapi.json'), '--json'], root, log);
    expect(JSON.parse(lines.join('\n'))).toEqual({
      endpoints: [
        {
          key: 'GET /items/{id}',
          method: 'GET',
          template: '/items/{id}',
          operationId: 'getItem',
          specRef: '#/paths/~1items~1{id}/get',
        },
      ],
      skipped: [{ key: 'POST /notify', reason: 'x-bugpatrol-skip' }],
    });
    await expect(readFile(paths.appMap(root))).rejects.toThrow(/ENOENT/);
  });

  it('reads --spec as a file: URL, and resolves placeholders in app.connect.spec', async () => {
    await runEndpointsCommand(['--spec', pathToFileURL(join(root, 'openapi.json')).href], root, log);
    expect(lines.at(-1)).toBe('\n1 endpoint(s), 1 skipped.');
    process.env.BUGPATROL_TEST_SPEC = 'openapi.json';
    try {
      const config = parseConfig({
        version: 1,
        app: { platform: 'api', connect: { url: 'http://127.0.0.1:9', spec: '${BUGPATROL_TEST_SPEC}' } },
      });
      lines = [];
      await runEndpointsCommand([], root, log, config);
      expect(lines.at(-1)).toBe('\n1 endpoint(s), 1 skipped.');
    } finally {
      delete process.env.BUGPATROL_TEST_SPEC;
    }
  });

  it('reads the endpoint inventory when there is no spec', async () => {
    const config = parseConfig({ version: 1, app: { platform: 'api', connect: { url: 'http://127.0.0.1:9' } } });
    await expect(runEndpointsCommand([], root, log, config)).rejects.toThrow(/app.connect.spec/);
    await mkdir(join(root, '.bugpatrol'), { recursive: true });
    await writeFile(paths.endpointInventory(root), 'endpoints:\n  - {method: GET, path: /items}\n');
    await runEndpointsCommand([], root, log, config);
    expect(lines).toEqual(['GET /items  allowed', '\n1 endpoint(s), 0 skipped.']);
  });

  it('marks each endpoint allowed, read-only, or denied', async () => {
    await mkdir(join(root, '.bugpatrol'), { recursive: true });
    await writeFile(
      paths.endpointInventory(root),
      'endpoints:\n  - {method: GET, path: /items}\n  - {method: POST, path: /items}\n  - {method: POST, path: /admin/wipe}\n',
    );
    const connect = { url: 'https://api.example.com', deny: ['/admin/**'] };
    const shared = parseConfig({ version: 1, app: { platform: 'api', connect } });
    await runEndpointsCommand([], root, log, shared);
    expect(lines.slice(0, 3)).toEqual([
      'GET /items  allowed',
      'POST /items  read-only',
      'POST /admin/wipe  denied: app.connect.deny has /admin/**',
    ]);
  });
});
