import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixtureApi, fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContract } from './contract.js';
import { loadInventory, loadSpec, type OpenApiDoc, specSource } from './load.js';

const MiB = 1024 * 1024;

describe('loadSpec', () => {
  let api: FixtureApi;
  beforeAll(async () => {
    api = await startFixtureApi();
  });
  afterAll(() => api.close());

  it('ignores servers', async () => {
    const doc = await loadSpec({ url: `${api.url}/openapi.json` });
    expect(doc.servers).toBeUndefined();
    expect(Object.keys(doc.paths)).toContain('/items/{id}');

    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-spec-'));
    try {
      const file = join(dir, 'openapi.yaml');
      await writeFile(
        file,
        [
          'openapi: 3.0.3',
          'servers: [{url: https://prod.invalid}]',
          'paths:',
          '  /a:',
          '    servers: [{url: https://prod.invalid}]',
          '    get: {servers: [{url: https://prod.invalid}], responses: {}}',
        ].join('\n'),
      );
      expect(JSON.stringify(await loadSpec({ file }))).not.toContain('prod.invalid');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('loads a spec over 1 MiB', async () => {
    const doc = await loadSpec({ url: `${api.url}/openapi-big.json` });
    expect(JSON.stringify(doc).length).toBeGreaterThan(2 * MiB);
    expect(doc.servers).toBeUndefined();
  });

  it('rejects a spec over maxBytes', async () => {
    await expect(loadSpec({ url: `${api.url}/openapi-big.json` }, { maxBytes: MiB })).rejects.toThrow(
      /larger than 1048576 bytes/,
    );
    await expect(loadSpec({ file: fixtureSpecPath }, { maxBytes: 1000 })).rejects.toThrow(/larger than 1000 bytes/);
  });

  it('uses only the injected fetch', async () => {
    const urls: string[] = [];
    const doc = await loadSpec(
      { url: 'https://spec.invalid/openapi.json' },
      {
        fetch: async (url) => {
          urls.push(String(url));
          return new Response(JSON.stringify({ openapi: '3.1.0', paths: {} }));
        },
      },
    );
    expect(urls).toEqual(['https://spec.invalid/openapi.json']);
    expect(doc.paths).toEqual({});
  });

  it('rejects a document that is not OpenAPI 3', async () => {
    const fetch = async () => new Response(JSON.stringify({ swagger: '2.0', paths: {} }));
    await expect(loadSpec({ url: 'https://spec.invalid/' }, { fetch })).rejects.toThrow(/not an OpenAPI 3 document/);
  });
});

describe('buildContract', () => {
  it('dedups by operationId', () => {
    const operation = { operationId: 'getAccount', responses: {} };
    const doc: OpenApiDoc = {
      openapi: '3.1.0',
      paths: {
        '/accounts/{id}': { get: operation },
        '/v2/accounts/{id}': { get: operation, delete: { responses: {} } },
      },
    };
    expect(buildContract(doc, {}).endpoints.map((endpoint) => endpoint.key)).toEqual([
      'GET /accounts/{id}',
      'DELETE /v2/accounts/{id}',
    ]);
  });
});

describe('loadInventory', () => {
  it('turns method and path rows into a doc without schemas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-inventory-'));
    try {
      const file = join(dir, 'endpoints.yml');
      await writeFile(file, 'endpoints:\n  - {method: get, path: /items}\n  - {method: POST, path: /items}\n');
      const contract = buildContract(await loadInventory(file), {});
      expect(contract.endpoints.map((endpoint) => endpoint.key)).toEqual(['GET /items', 'POST /items']);

      await writeFile(file, 'endpoints:\n  - {method: FETCH, path: /items}\n');
      await expect(loadInventory(file)).rejects.toThrow(/endpoint 1 needs a method/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('specSource', () => {
  it('reads a URL, a path on connect.url, or a file under the root', () => {
    expect(specSource('https://api.example.com/openapi.json', { root: '/repo' })).toEqual({
      url: 'https://api.example.com/openapi.json',
    });
    expect(specSource('/openapi.json', { root: '/repo', url: 'http://127.0.0.1:8000/api/' })).toEqual({
      url: 'http://127.0.0.1:8000/api/openapi.json',
    });
    expect(specSource('docs/openapi.yaml', { root: '/repo' })).toEqual({ file: '/repo/docs/openapi.yaml' });
    expect(() => specSource('/openapi.json', { root: '/repo' })).toThrow(/connect.url is not set/);
  });
});
