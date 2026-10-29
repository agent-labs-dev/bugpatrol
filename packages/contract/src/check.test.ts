import { type FixtureApi, fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import type { AssertionResult } from '@bugpatrol/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ContractResponse, checkContract, checkSchema } from './check.js';
import { buildContract, type Contract } from './contract.js';
import { loadSpec } from './load.js';

// One test for each judge rule of the calibration sheet that code can check.
let fixture: FixtureApi;
let contract: Contract;
beforeAll(async () => {
  fixture = await startFixtureApi({ perSecond: 1000 });
  contract = buildContract(await loadSpec({ file: fixtureSpecPath }), {});
});
afterAll(() => fixture.close());

async function send(method: string, path: string, body?: unknown): Promise<ContractResponse> {
  const response = await fetch(`${fixture.url}${path}`, {
    method,
    headers: {
      authorization: 'Bearer fixture-token-a',
      'x-workspace-id': 'ws-a',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, headers, text, ...(json === undefined ? {} : { json }) };
}

async function check(method: string, path: string, body?: unknown, on = contract) {
  const endpoint = on.match(method, path);
  if (!endpoint) throw new Error(`No endpoint for ${method} ${path}`);
  return verdicts(checkContract(endpoint, await send(method, path, body), on));
}

/** Each sub-check by id, with its actual value when it fails. */
const verdicts = (results: AssertionResult[]) =>
  Object.fromEntries(
    results.map((result) => [
      result.assertion.kind === 'contract' ? result.assertion.check : result.assertion.kind,
      result.ok ? 'ok' : `failed: ${result.actual}`,
    ]),
  );

describe('checkContract', () => {
  it('undeclared status fails', async () => {
    // getItem declares only 200; a missing id returns 404.
    expect(await check('GET', '/items/999')).toEqual({ status: 'failed: 404', 'no-5xx': 'ok' });
    // createItem declares 201 and 422; a bad body returns 200.
    expect(await check('POST', '/items', {})).toMatchObject({ status: 'failed: 200' });
    expect(await check('GET', '/items/0')).toEqual({ status: 'failed: 500', 'no-5xx': 'failed: 500' });
  });

  it('a status in connect.errors is declared, and its body matches the errors schema', async () => {
    const schema = {
      type: 'object',
      required: ['error'],
      properties: { error: { type: 'object', properties: { code: { type: 'string' } } } },
    };
    const withErrors = buildContract(contract.doc, { errors: { statuses: [404], schema } });
    expect(await check('GET', '/items/999', undefined, withErrors)).toEqual({
      status: 'ok',
      'no-5xx': 'ok',
      schema: 'failed: /error must NOT have additional properties (message)',
    });
  });

  it('undeclared field fails, even when harmless', async () => {
    expect(await check('GET', '/items')).toEqual({
      status: 'ok',
      'no-5xx': 'ok',
      'content-type': 'ok',
      schema: expect.stringMatching(/^failed: \/result\/0 must NOT have unevaluated properties \(internal_note\)/),
    });
  });

  it('closes an allOf at its parent, so a field of each branch passes', async () => {
    const response = await send('GET', '/items/1');
    expect(checkSchema('#/components/schemas/ItemResult', response, contract)).toEqual({
      assertion: { kind: 'schema', ref: '#/components/schemas/ItemResult' },
      ok: true,
    });
    const extra = { result: { ...(response.json as { result: object }).result, extra: 1 } };
    expect(checkSchema('#/components/schemas/ItemResult', { ...response, json: extra }, contract)).toMatchObject({
      ok: false,
      actual: '/result must NOT have unevaluated properties (extra)',
    });
  });

  it('missing Location passes', async () => {
    const created = await send('POST', '/items', { name: 'new' });
    expect(created.status).toBe(201);
    expect(created.headers.location).toBeUndefined();
    expect(await check('POST', '/items', { name: 'new' })).toEqual({
      status: 'ok',
      'no-5xx': 'ok',
      'content-type': 'ok',
      schema: 'ok',
    });
  });

  it('slow response passes', async () => {
    const started = Date.now();
    expect(await check('GET', '/search?q=a')).toEqual({
      status: 'ok',
      'no-5xx': 'ok',
      'content-type': 'ok',
      schema: 'ok',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
  });

  it('gives a schema that does not compile as a failed check', () => {
    const broken = buildContract(
      {
        openapi: '3.1.0',
        paths: {
          '/x': {
            get: {
              responses: {
                '200': {
                  description: 'x',
                  content: { 'application/json': { schema: { type: 'object', minProperty: 1 } } },
                },
              },
            },
          },
        },
      },
      {},
    );
    const raw = { status: 200, headers: { 'content-type': 'application/json' }, text: '{}', json: {} };
    expect(verdicts(checkContract(broken.endpoints[0]!, raw, broken)).schema).toMatch(
      /^failed: the schema does not compile: strict mode: unknown keyword: "minProperty"/,
    );
  });
});
