import { buildContract, type OpenApiDoc, sweepCases } from '@bugpatrol/contract';
import { expect, it } from 'vitest';
import { toAction } from './replay.js';
import type { AgentSession } from './session.js';
import { Vars } from './vars.js';

it.each([{ allOf: [{ type: 'integer' }] }, { anyOf: [{ type: 'integer' }, { type: 'null' }] }])(
  'preserves response-captured numeric ids declared through %j',
  (idSchema) => {
    const item = { type: 'object', required: ['id'], properties: { id: idSchema } };
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/items': {
          get: {
            responses: { '200': { content: { 'application/json': { schema: { type: 'array', items: item } } } } },
          },
        },
        '/items/{id}': {
          put: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
            requestBody: { content: { 'application/json': { schema: item } } },
            responses: { '200': {} },
          },
        },
      },
    } as unknown as OpenApiDoc;
    const planned = sweepCases(buildContract(doc, {}), { credentials: { self: {} } }).find(
      (entry) => entry.endpoint.method === 'PUT' && entry.case === 'ok',
    )!;
    expect(planned.blocked).toBeUndefined();
    expect(planned.steps[0]).toMatchObject({ kind: 'request', capture: { RESPONSE_ID: '/0/id' } });
    const vars = new Vars();
    vars.capture({ RESPONSE_ID: '7' });
    const action = toAction(planned.steps.at(-1)!, { vars } as AgentSession);
    if (action.kind !== 'request') throw new Error('Expected request');
    expect(action.url).toBe('/items/7');
    expect(JSON.parse(action.body!)).toEqual({ id: 7 });
  },
);
