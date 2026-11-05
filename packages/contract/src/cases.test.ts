import { fixtureSpecPath } from '@bugpatrol/api-fixture';
import type { EndpointKey, RoutineStep } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { type CaseVerdict, coverageCells, missingId, type SweepCase, specLacksErrors, sweepCases } from './cases.js';
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
      { case: 'GET /health ok', steps: ['GET /health expect contract,200'] },
      { case: 'GET /version ok', steps: ['GET /version expect contract,200'] },
      { case: 'GET /version/fleet ok', steps: ['GET /version/fleet expect contract,200'] },
      { case: 'GET /items ok', steps: ['GET /items expect contract,200'] },
      { case: 'GET /items no-auth', steps: ['as none GET /items expect contract,401'] },
      { case: 'POST /items ok', steps: ['POST /items {"name":"bugpatrol"} expect contract,201'] },
      { case: 'POST /items no-auth', steps: ['as none POST /items {"name":"bugpatrol"} expect contract,401'] },
      { case: 'POST /items invalid-input', steps: ['POST /items {} expect contract,422'] },
      {
        case: 'GET /items/{id} ok',
        steps: ['GET /items capture {"RESPONSE_ID":"/result/0/id"}', 'GET /items/{{RESPONSE_ID}} expect contract,200'],
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
          'GET /items capture {"RESPONSE_ID":"/result/0/id"}',
          'PATCH /items/{{RESPONSE_ID}} {"name":"bugpatrol"} expect contract,200',
        ],
      },
      {
        case: 'PATCH /items/{id} no-auth',
        steps: [
          'GET /items capture {"RESPONSE_ID":"/result/0/id"}',
          'as none PATCH /items/{{RESPONSE_ID}} {"name":"bugpatrol"} expect contract,401',
        ],
      },
      {
        case: 'PATCH /items/{id} invalid-input',
        steps: [
          'GET /items capture {"RESPONSE_ID":"/result/0/id"}',
          'PATCH /items/{{RESPONSE_ID}} {} expect contract,422',
        ],
      },
      {
        case: 'PATCH /items/{id} missing-id',
        steps: [
          'GET /items capture {"RESPONSE_ID":"/result/0/id"}',
          'PATCH /items/{{RESPONSE_ID|missing}} {"name":"bugpatrol"} expect contract,404',
        ],
      },
      {
        case: 'DELETE /items/{id} ok',
        steps: [
          'POST /items {"name":"bugpatrol"} capture {"RESPONSE_ID":"/result/id"}',
          'DELETE /items/{{RESPONSE_ID}} expect contract,204',
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
          'GET /items capture {"RESPONSE_ID":"/result/0/id"}',
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
      { case: 'GET /search ok', steps: ['GET /search expect contract,200'] },
      { case: 'GET /search no-auth', steps: ['as none GET /search expect contract,401'] },
      { case: 'GET /events ok', steps: ['GET /events expect contract,200'] },
      { case: 'GET /export ok', steps: ['GET /export expect contract,200'] },
      { case: 'GET /export no-auth', steps: ['as none GET /export expect contract,401'] },
      { case: 'POST /admin/wipe ok', steps: ['POST /admin/wipe expect contract,204'] },
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
          'GET /workspaces/{{WORKSPACE_A}}/threads/{{RESPONSE_ID}} expect contract,200',
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

  it.each([
    { declares: ['200', '401'], expects: [200] },
    { declares: ['201', '422'], expects: [201] },
    { declares: ['302', '404', '503'], expects: [302] },
    // Without a declared success, any 2xx passes, and no 4xx does.
    { declares: ['default'], expects: Array.from({ length: 100 }, (_, index) => 200 + index) },
  ])('the ok case of an operation that declares $declares expects only a success', ({ declares, expects }) => {
    const doc = {
      openapi: '3.1.0',
      paths: { '/plans': { get: { responses: Object.fromEntries(declares.map((code) => [code, {}])) } } },
    } as unknown as OpenApiDoc;
    const [ok] = sweepCases(buildContract(doc, {}), { credentials: SELF });
    expect(ok?.steps.at(-1)).toMatchObject({ assert: [{ kind: 'contract' }, { kind: 'status', value: expects }] });
  });

  it('resolves an id from the list first, then the create, on each method of a path', () => {
    const json = (schema: unknown) => ({ description: 'ok', content: { 'application/json': { schema } } });
    const param = (name: string) => [{ name, in: 'path', required: true, schema: { type: 'string' } }];
    const named = { type: 'object', properties: { name: { type: 'string' } } };
    const listed = json({ type: 'array', items: named });
    const secret = {
      type: 'object',
      required: ['name', 'value'],
      properties: { name: { type: 'string' }, value: { type: 'string' } },
    };
    const body = { content: { 'application/json': { schema: secret } } };
    const doc = {
      openapi: '3.1.0',
      paths: {
        // A vault of secrets: a list and no create.
        '/secrets': { get: { responses: { '200': listed } } },
        '/secrets/{name}': {
          parameters: param('name'),
          get: { responses: { '200': json(named), '404': {} } },
          put: { requestBody: body, responses: { '200': json(named), '404': {}, '422': {} } },
          delete: { responses: { '204': {}, '404': {} } },
        },
        // A list and a create.
        '/hooks': {
          get: { responses: { '200': json({ type: 'array', items: { properties: { id: {} } } }) } },
          post: { responses: { '201': json({ properties: { id: {} } }), '422': {} } },
        },
        '/hooks/{id}/rotate': { parameters: param('id'), post: { responses: { '200': json({}), '404': {} } } },
        '/hooks/{id}': { parameters: param('id'), delete: { responses: { '204': {}, '404': {} } } },
      },
    } as unknown as OpenApiDoc;
    const cases = sweepCases(buildContract(doc, {}), { credentials: SELF });
    const first = (key: string) => {
      const item = cases.find((one) => `${one.endpoint.key} ${one.case}` === key)!;
      return item.blocked ?? line(item.steps[0]!);
    };
    const LIST = 'GET /secrets capture {"RESPONSE_NAME":"/0/name"}';
    const HOOKS = 'GET /hooks capture {"RESPONSE_ID":"/0/id"}';
    expect(
      Object.fromEntries(
        [
          'GET /secrets/{name} ok',
          'PUT /secrets/{name} ok',
          'PUT /secrets/{name} missing-id',
          'DELETE /secrets/{name} missing-id',
          'DELETE /secrets/{name} ok',
          'POST /hooks/{id}/rotate ok',
          'POST /hooks/{id}/rotate missing-id',
          'DELETE /hooks/{id} missing-id',
          'DELETE /hooks/{id} ok',
        ].map((key) => [key, first(key)]),
      ),
    ).toEqual({
      'GET /secrets/{name} ok': LIST,
      'PUT /secrets/{name} ok': LIST,
      'PUT /secrets/{name} missing-id': LIST,
      // A missing id only takes the shape of a listed one, so a DELETE may list.
      'DELETE /secrets/{name} missing-id': LIST,
      // A DELETE deletes only a resource that it made.
      'DELETE /secrets/{name} ok':
        'no known name: the spec has no example, and a DELETE deletes only a resource that the sweep made, which needs a create on /secrets',
      'POST /hooks/{id}/rotate ok': HOOKS,
      'POST /hooks/{id}/rotate missing-id': HOOKS,
      'DELETE /hooks/{id} missing-id': HOOKS,
      'DELETE /hooks/{id} ok': 'POST /hooks capture {"RESPONSE_ID":"/id"}',
    });
  });

  it.each([
    { name: 'a known id', example: undefined, ok: '{{RESPONSE_NAME}}', missing: '{{RESPONSE_NAME|missing}}' },
    { name: 'a spec example', example: 'API_KEY', ok: 'API_KEY', missing: 'API_ZZZ' },
  ])('a body field with the name of a path parameter takes its value, from $name', ({ example, ok, missing }) => {
    const json = (schema: unknown) => ({ description: 'ok', content: { 'application/json': { schema } } });
    const secret = {
      type: 'object',
      required: ['name', 'value'],
      properties: { name: { type: 'string' }, value: { type: 'string' } },
    };
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/secrets': { get: { responses: { '200': json({ type: 'array', items: secret }) } } },
        '/secrets/{name}': {
          put: {
            parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' }, example }],
            requestBody: { content: { 'application/json': { schema: secret } } },
            responses: { '200': json(secret), '404': {} },
          },
        },
      },
    } as unknown as OpenApiDoc;
    const bodies = Object.fromEntries(
      sweepCases(buildContract(doc, {}), { credentials: SELF })
        .filter((item) => (item.case === 'ok' && item.endpoint.method === 'PUT') || item.case === 'missing-id')
        .map((item) => {
          const step = item.steps.at(-1)!;
          return [item.case, step.kind === 'request' ? JSON.parse(step.body!) : undefined];
        }),
    );
    expect(bodies).toEqual({
      ok: { name: ok, value: 'bugpatrol' },
      'missing-id': { name: missing, value: 'bugpatrol' },
    });
  });

  it('an upsert PUT, one that declares 201, has no missing-id failure: a missing id creates the resource', () => {
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/secrets/{name}': {
          put: {
            parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' }, example: 'KEY' }],
            responses: { '200': {}, '201': {}, '404': {} },
          },
        },
      },
    } as unknown as OpenApiDoc;
    const missing = sweepCases(buildContract(doc, {}), { credentials: SELF }).find((c) => c.case === 'missing-id');
    expect(missing?.blocked).toBe('PUT /secrets/{name} declares 201, so a missing name creates the resource');
  });

  it('a body field mirroring a number path parameter stays a number', () => {
    const item = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/items/{id}': {
          put: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 7 }],
            requestBody: { content: { 'application/json': { schema: item } } },
            responses: { '200': {} },
          },
        },
      },
    } as unknown as OpenApiDoc;
    const [ok] = sweepCases(buildContract(doc, {}), { credentials: SELF });
    const step = ok!.steps.at(-1)!;
    expect(step.kind === 'request' && JSON.parse(step.body!)).toEqual({ id: 7 });
  });
});

describe('coverageCells', () => {
  const base = { endpoint: 'POST /invitations/{token}/accept' as EndpointKey, at: 'now', exchange: 'x.exchange.json' };
  const shape = (cells: ReturnType<typeof coverageCells>) =>
    Object.fromEntries(
      cells.map((cell) => [
        cell.case,
        { ok: cell.ok, failed: cell.failed, ...(cell.blocked ? { blocked: true } : {}) },
      ]),
    );
  it.each<{ name: string; verdict: Omit<CaseVerdict, keyof typeof base>; cells: ReturnType<typeof shape> }>([
    {
      // The case expected 404, the 401 is declared: each cell keeps its own expectation.
      name: 'a missing-id case that got a declared 401',
      verdict: { case: 'missing-id', status: 401, declared: true, failed: ['status'] },
      cells: { 'missing-id': { ok: false, failed: ['status'] }, 'declared:401': { ok: true, failed: [] } },
    },
    {
      name: 'a declared 401 whose body breaks its schema',
      verdict: { case: 'missing-id', status: 401, declared: true, failed: ['contract:schema', 'status'] },
      cells: {
        'missing-id': { ok: false, failed: ['contract:schema', 'status'] },
        'declared:401': { ok: false, failed: ['contract:schema'] },
      },
    },
    {
      // Credentials that the endpoint does not accept block the case, and the 401 still covers its column.
      name: 'a blocked case with a declared 401',
      verdict: { case: 'missing-id', status: 401, declared: true, failed: [], blocked: 'credentials not accepted' },
      cells: { 'missing-id': { ok: false, failed: [], blocked: true }, 'declared:401': { ok: true, failed: [] } },
    },
    {
      name: 'an ok case that got a declared 2xx',
      verdict: { case: 'ok', status: 200, declared: true, failed: [] },
      cells: { ok: { ok: true, failed: [] } },
    },
    {
      name: 'an undeclared 404',
      verdict: { case: 'missing-id', status: 404, declared: false, failed: ['contract:status'] },
      cells: { 'missing-id': { ok: false, failed: ['contract:status'] } },
    },
  ])('$name', ({ verdict, cells }) => {
    expect(shape(coverageCells({ ...base, ...verdict }))).toEqual(cells);
  });
});
