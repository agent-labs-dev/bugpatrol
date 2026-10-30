import { fixtureSpecPath } from '@bugpatrol/api-fixture';
import { describe, expect, it } from 'vitest';
import { buildContract } from './contract.js';
import { loadSpec } from './load.js';

describe('buildContract', () => {
  it('gives the fixture endpoints and skips the x-bugpatrol-skip operation', async () => {
    const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), {});
    expect(contract.endpoints.map((endpoint) => endpoint.key).sort()).toEqual(
      [
        'DELETE /items/{id}',
        'GET /events',
        'GET /export',
        'GET /health',
        'GET /items',
        'GET /items/{id}',
        'GET /search',
        'GET /version',
        'GET /version/fleet',
        'PATCH /items/{id}',
        'POST /admin/wipe',
        'POST /items',
      ].sort(),
    );
    expect(contract.skipped).toEqual([{ key: 'POST /notify', reason: 'x-bugpatrol-skip' }]);
  });

  it('points each endpoint at its operation', async () => {
    const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), {});
    const endpoint = contract.endpoints.find((item) => item.key === 'PATCH /items/{id}');
    expect(endpoint).toEqual({
      key: 'PATCH /items/{id}',
      method: 'PATCH',
      template: '/items/{id}',
      operationId: 'updateItem',
      specRef: '#/paths/~1items~1{id}/patch',
    });
    expect(contract.doc.paths['/items/{id}']?.patch).toMatchObject({ operationId: 'updateItem' });
  });

  it('skips an operation that streams events', () => {
    const contract = buildContract(
      {
        openapi: '3.1.0',
        paths: {
          '/stream': {
            get: { responses: { '200': { description: 'Events.', content: { 'text/event-stream': {} } } } },
          },
        },
      },
      {},
    );
    expect(contract.endpoints).toEqual([]);
    expect(contract.skipped).toEqual([{ key: 'GET /stream', reason: 'event-stream' }]);
  });

  it('normalizes connect.errors', () => {
    const schema = { type: 'object', required: ['error'] };
    const doc = { openapi: '3.1.0', paths: {} };
    expect(buildContract(doc, { errors: { statuses: [422, 401, 422], schema } }).errors).toEqual({
      statuses: [401, 422],
      schema,
    });
    expect(buildContract(doc, {}).errors).toEqual({ statuses: [] });
  });
});
