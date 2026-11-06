import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContract, type OpenApiDoc, sweepCases } from '@bugpatrol/contract';
import { parseConfig } from '@bugpatrol/core';
import { createDriver } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { AgentSession } from './session.js';
import { runSweep } from './sweep.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('reports a response schema violation even when a declared 503 blocks the success case', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 123 }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-prerequisite-schema-'));
  try {
    const config = parseConfig({
      version: 1,
      app: {
        platform: 'api',
        connect: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, perMinute: 60_000 },
      },
    });
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/health': {
          get: {
            security: [],
            responses: {
              '200': { description: 'ok' },
              '503': {
                description: 'unavailable',
                content: {
                  'application/json': {
                    schema: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenApiDoc;
    const contract = buildContract(doc, config.app.connect);
    const driver = createDriver(config, (value) => value, undefined, root, contract);
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    const result = await runSweep(session, sweepCases(contract, { credentials: { self: {} } }), {
      maxRequests: 10,
      timeoutMs: 10_000,
    });
    expect(result.cells.find((cell) => cell.case === 'declared:503')?.failed).toContain('contract:schema');
    expect(result.findings.some((finding) => finding.failed.includes('contract:schema'))).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
