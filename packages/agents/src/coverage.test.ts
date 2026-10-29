import { fixtureSpecPath } from '@bugpatrol/api-fixture';
import { buildContract, caseKey, loadSpec } from '@bugpatrol/contract';
import type { CoverageFile, EndpointKey } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { rankForExplorer } from './coverage.js';

describe('rankForExplorer', async () => {
  const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), {});
  const cell = (endpoint: string, at: string, extra: { ok?: boolean; repeats?: boolean } = {}) => ({
    [caseKey(endpoint as EndpointKey, 'ok')]: {
      endpoint: endpoint as EndpointKey,
      case: 'ok' as const,
      ok: extra.ok ?? true,
      failed: extra.ok === false ? ['contract:status'] : [],
      ...(extra.repeats === undefined ? {} : { repeats: extra.repeats }),
      at,
    },
  });
  // Each endpoint has a cell, except GET /search. GET /health has the oldest one.
  const coverage: CoverageFile = {
    version: 1,
    cells: Object.assign(
      {},
      ...contract.endpoints
        .filter((endpoint) => endpoint.key !== 'GET /search')
        .map((endpoint) => cell(endpoint.key, '2026-01-02T00:00:00.000Z')),
      cell('GET /health', '2026-01-01T00:00:00.000Z'),
      cell('GET /items', '2026-01-03T00:00:00.000Z', { ok: false, repeats: true }),
      cell('GET /items/{id}', '2026-01-03T00:00:00.000Z', { ok: false, repeats: false }),
    ),
  };
  const ranked = (options: { writesAllowed: boolean; crossUser: boolean }, n = 20) =>
    rankForExplorer(coverage, contract, n, options).map((item) => `${item.endpoint.key}: ${item.reason}`);

  it('orders no coverage, failures that did not repeat, writes, cross-user cases, then the oldest coverage', () => {
    expect(ranked({ writesAllowed: true, crossUser: true })).toEqual([
      'GET /search: no coverage yet',
      'GET /items/{id}: a sweep failure that did not repeat',
      'POST /items: a write operation',
      'PATCH /items/{id}: a write operation',
      'DELETE /items/{id}: a write operation',
      'POST /admin/wipe: a write operation',
      'GET /health: the oldest coverage',
      ...contract.endpoints
        .map((endpoint) => endpoint.key)
        .filter((key) => !['GET /search', 'GET /health', 'GET /items', 'GET /items/{id}'].includes(key))
        .filter((key) => key.startsWith('GET'))
        .map((key) => `${key}: the oldest coverage`),
      // A failure that repeats is a confirmed bug, and its cell is the newest.
      'GET /items: the oldest coverage',
    ]);
  });

  it('leaves out writes on a read-only target, ranks cross-user cases, and keeps n', () => {
    expect(ranked({ writesAllowed: false, crossUser: true }, 5)).toEqual([
      'GET /search: no coverage yet',
      'GET /items/{id}: a sweep failure that did not repeat',
      'PATCH /items/{id}: a cross-user case',
      'DELETE /items/{id}: a cross-user case',
      'GET /health: the oldest coverage',
    ]);
  });
});
