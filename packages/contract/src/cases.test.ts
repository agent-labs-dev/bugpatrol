import { fixtureSpecPath } from '@bugpatrol/api-fixture';
import type { RoutineStep } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { missingId, type SweepCase, specLacksErrors, sweepCases } from './cases.js';
import { buildContract } from './contract.js';
import { loadSpec, type OpenApiDoc } from './load.js';

const line = (step: RoutineStep) =>
  step.kind === 'request'
    ? [
        step.as ? `as ${step.as}` : '',
        step.method,
        step.url,
        step.body ?? '',
        step.capture ? `capture ${JSON.stringify(step.capture)}` : '',
        step.assert ? `expect ${step.assert.map((item) => ('value' in item ? item.value : item.kind)).join(',')}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    : step.kind;

const SELF = { self: { Authorization: 'Bearer a' } };
const BOTH = { ...SELF, other: { Authorization: 'Bearer b' } };

const golden = (cases: SweepCase[]) =>
  cases.map((item) => ({
    case: `${item.endpoint.key} ${item.case}`,
    ...(item.blocked ? { blocked: item.blocked } : { steps: item.steps.map(line) }),
  }));

describe('sweepCases', () => {
  it('gives the golden case list for the fixture spec', async () => {
    const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), { errors: { statuses: [401, 409] } });
    expect(specLacksErrors(contract)).toBe(false);
    expect(golden(sweepCases(contract, { credentials: SELF }))).toEqual([
      { case: 'GET /health ok', steps: ['GET /health expect contract'] },
      { case: 'GET /version ok', steps: ['GET /version expect contract'] },
      { case: 'GET /version/fleet ok', steps: ['GET /version/fleet expect contract'] },
      { case: 'GET /items ok', steps: ['GET /items expect contract'] },
      { case: 'GET /items no-auth', steps: ['as none GET /items expect contract,401'] },
      { case: 'POST /items ok', steps: ['POST /items {"name":"bugpatrol"} expect contract'] },
      { case: 'POST /items no-auth', steps: ['as none POST /items {"name":"bugpatrol"} expect contract,401'] },
      { case: 'POST /items invalid-input', steps: ['POST /items {} expect contract,422'] },
      {
        case: 'GET /items/{id} ok',
        steps: ['GET /items capture {"RESPONSE_ID":"/result/0/id"}', 'GET /items/{{RESPONSE_ID}} expect contract'],
      },
      {
        case: 'GET /items/{id} no-auth',
        steps: [
          'GET /items capture {"RESPONSE_ID":"/result/0/id"}',
          'as none GET /items/{{RESPONSE_ID}} expect contract,401',
        ],
      },
      {
        case: 'GET /items/{id} invalid-input',
        steps: ['GET /items capture {"RESPONSE_ID":"/result/0/id"}', 'GET /items/0 expect contract,422'],
      },
      { case: 'GET /items/{id} missing-id', steps: ['GET /items/2147483647 expect contract,404'] },
      { case: 'GET /items/{id} other-user', blocked: 'other-user needs a second credential set' },
      {
        case: 'PATCH /items/{id} ok',
        steps: [
          'POST /items {"name":"bugpatrol"} capture {"RESPONSE_ID":"/result/id"}',
          'PATCH /items/{{RESPONSE_ID}} {"name":"bugpatrol"} expect contract',
        ],
      },
      {
        case: 'PATCH /items/{id} no-auth',
        steps: [
          'POST /items {"name":"bugpatrol"} capture {"RESPONSE_ID":"/result/id"}',
          'as none PATCH /items/{{RESPONSE_ID}} {"name":"bugpatrol"} expect contract,401',
        ],
      },
      {
        case: 'PATCH /items/{id} invalid-input',
        steps: [
          'POST /items {"name":"bugpatrol"} capture {"RESPONSE_ID":"/result/id"}',
          'PATCH /items/{{RESPONSE_ID}} {} expect contract,422',
        ],
      },
      {
        case: 'PATCH /items/{id} missing-id',
        steps: [
          'POST /items {"name":"bugpatrol"} capture {"RESPONSE_ID":"/result/id"}',
          'PATCH /items/{{RESPONSE_ID|missing}} {"name":"bugpatrol"} expect contract,404',
        ],
      },
      {
        case: 'DELETE /items/{id} ok',
        steps: [
          'POST /items {"name":"bugpatrol"} capture {"RESPONSE_ID":"/result/id"}',
          'DELETE /items/{{RESPONSE_ID}} expect contract',
        ],
      },
      {
        case: 'DELETE /items/{id} no-auth',
        steps: [
          'POST /items {"name":"bugpatrol"} capture {"RESPONSE_ID":"/result/id"}',
          'as none DELETE /items/{{RESPONSE_ID}} expect contract,401',
        ],
      },
      {
        case: 'DELETE /items/{id} missing-id',
        steps: [
          'POST /items {"name":"bugpatrol"} capture {"RESPONSE_ID":"/result/id"}',
          'DELETE /items/{{RESPONSE_ID|missing}} expect contract,404',
        ],
      },
      {
        case: 'DELETE /items/{id} repeat-delete',
        steps: [
          'POST /items {"name":"bugpatrol"} capture {"RESPONSE_ID":"/result/id"}',
          'DELETE /items/{{RESPONSE_ID}}',
          'DELETE /items/{{RESPONSE_ID}} expect contract,404',
        ],
      },
      { case: 'GET /search ok', steps: ['GET /search expect contract'] },
      { case: 'GET /search no-auth', steps: ['as none GET /search expect contract,401'] },
      { case: 'GET /events ok', steps: ['GET /events expect contract'] },
      { case: 'GET /export ok', steps: ['GET /export expect contract'] },
      { case: 'GET /export no-auth', steps: ['as none GET /export expect contract,401'] },
      { case: 'POST /admin/wipe ok', steps: ['POST /admin/wipe expect contract'] },
      { case: 'POST /admin/wipe no-auth', steps: ['as none POST /admin/wipe expect contract,401'] },
    ]);
  });

  it('reads the same URL as self, then as other, with two credential sets', async () => {
    const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), {});
    const other = sweepCases(contract, { credentials: BOTH }).find((item) => item.case === 'other-user');
    expect(other?.steps.map(line)).toEqual([
      'GET /items capture {"RESPONSE_ID":"/result/0/id"}',
      'GET /items/{{RESPONSE_ID}}',
      'as other GET /items/{{RESPONSE_ID}} expect contract,404',
    ]);
  });

  it('blocks the no-auth cases when no credential headers are configured', async () => {
    const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), { errors: { statuses: [401] } });
    const noAuth = sweepCases(contract, { credentials: {} }).filter((item) => item.case === 'no-auth');
    expect(noAuth.length).toBeGreaterThan(0);
    expect(new Set(noAuth.map((item) => item.blocked))).toEqual(new Set(['no credentials configured']));
  });

  it('gives no negative case without a declared status for it', async () => {
    const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), {});
    const kinds = new Set(sweepCases(contract, { credentials: SELF }).map((item) => item.case));
    // The fixture spec declares 404 and 422, and no 401 or 403.
    expect([...kinds].sort()).toEqual(['invalid-input', 'missing-id', 'ok', 'other-user', 'repeat-delete']);
  });

  it('builds a missing id from a known id, else accepts a declared 400 or 422 for a made-up id', () => {
    const json = (schema: unknown) => ({ description: 'ok', content: { 'application/json': { schema } } });
    const id = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/threads': { get: { responses: { '200': json({ type: 'array', items: { properties: { id: {} } } }) } } },
        '/threads/{thread_id}': { get: { parameters: [id('thread_id')], responses: { '200': json({}), '404': {} } } },
        '/themes/{theme_id}': {
          get: { parameters: [id('theme_id')], responses: { '200': json({}), '400': {}, '404': {} } },
        },
      },
    } as unknown as OpenApiDoc;
    const missing = sweepCases(buildContract(doc, {}), { credentials: SELF }).filter(
      (item) => item.case === 'missing-id',
    );
    expect(golden(missing)).toEqual([
      {
        case: 'GET /threads/{thread_id} missing-id',
        steps: [
          'GET /threads capture {"RESPONSE_THREAD_ID":"/0/id"}',
          'GET /threads/{{RESPONSE_THREAD_ID|missing}} expect contract,404',
        ],
      },
      // No list or create gives a theme id, so the made-up id can fail its format check.
      { case: 'GET /themes/{theme_id} missing-id', steps: ['GET /themes/bugpatrol-missing expect contract,404,400'] },
    ]);
  });

  it('keeps the shape of a known id in the missing id', () => {
    expect(missingId('thrd_0123456789abcdef0123456789abcdef')).toBe(`thrd_${'f'.repeat(32)}`);
    expect(missingId('ORD-00A1F')).toBe('ORD-FFFFF');
    expect(missingId('cus_9s8dKJ2l')).toBe('cus_9z9zZZ9z');
    expect(missingId('ws-a')).toBe('ws-f');
    expect(missingId('2024-17')).toBe('9999-99');
    expect(missingId('7')).toBe('2147483647');
    expect(missingId('12345678901234')).toBe('99999999999999');
    expect(missingId('123e4567-e89b-12d3-a456-426614174000')).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('takes a path parameter with the name of a credential header from that header', () => {
    const json = (schema: unknown) => ({ description: 'ok', content: { 'application/json': { schema } } });
    const path = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/workspaces/{workspace_id}/threads': {
          parameters: [path('workspace_id')],
          get: { responses: { '200': json({ type: 'array', items: { properties: { id: {} } } }) } },
        },
        '/workspaces/{workspace_id}/threads/{id}': {
          parameters: [path('workspace_id'), path('id')],
          get: { responses: { '200': json({}), '404': {} } },
        },
      },
    } as unknown as OpenApiDoc;
    const credentials = {
      self: { Authorization: 'Bearer ${TOKEN_A}', 'X-Workspace-Id': '${WORKSPACE_A}' },
      other: { Authorization: 'Bearer ${TOKEN_B}', 'X-Workspace-Id': 'ws-b' },
    };
    const cases = sweepCases(buildContract(doc, {}), { credentials }).filter((item) =>
      item.endpoint.template.endsWith('{id}'),
    );
    expect(golden(cases)).toEqual([
      {
        case: 'GET /workspaces/{workspace_id}/threads/{id} ok',
        steps: [
          'GET /workspaces/{{WORKSPACE_A}}/threads capture {"RESPONSE_ID":"/0/id"}',
          'GET /workspaces/{{WORKSPACE_A}}/threads/{{RESPONSE_ID}} expect contract',
        ],
      },
      {
        case: 'GET /workspaces/{workspace_id}/threads/{id} missing-id',
        steps: [
          'GET /workspaces/{{WORKSPACE_A}}/threads capture {"RESPONSE_ID":"/0/id"}',
          'GET /workspaces/{{WORKSPACE_A}}/threads/{{RESPONSE_ID|missing}} expect contract,404',
        ],
      },
      {
        // The user other asks in its own workspace for the thread of self.
        case: 'GET /workspaces/{workspace_id}/threads/{id} other-user',
        steps: [
          'GET /workspaces/{{WORKSPACE_A}}/threads capture {"RESPONSE_ID":"/0/id"}',
          'GET /workspaces/{{WORKSPACE_A}}/threads/{{RESPONSE_ID}}',
          'as other GET /workspaces/ws-b/threads/{{RESPONSE_ID}} expect contract,404',
        ],
      },
    ]);
  });
});
