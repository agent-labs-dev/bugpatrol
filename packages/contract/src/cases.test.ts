import { fixtureSpecPath } from '@bugpatrol/api-fixture';
import type { RoutineStep } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { type SweepCase, specLacksErrors, sweepCases } from './cases.js';
import { buildContract } from './contract.js';
import { loadSpec } from './load.js';

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

const golden = (cases: SweepCase[]) =>
  cases.map((item) => ({
    case: `${item.endpoint.key} ${item.case}`,
    ...(item.blocked ? { blocked: item.blocked } : { steps: item.steps.map(line) }),
  }));

describe('sweepCases', () => {
  it('gives the golden case list for the fixture spec', async () => {
    const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), { errors: { statuses: [401, 409] } });
    expect(specLacksErrors(contract)).toBe(false);
    expect(golden(sweepCases(contract, { credentials: ['self'] }))).toEqual([
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
        steps: ['PATCH /items/bugpatrol-missing {"name":"bugpatrol"} expect contract,404'],
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
      { case: 'DELETE /items/{id} missing-id', steps: ['DELETE /items/bugpatrol-missing expect contract,404'] },
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
    const other = sweepCases(contract, { credentials: ['self', 'other'] }).find((item) => item.case === 'other-user');
    expect(other?.steps.map(line)).toEqual([
      'GET /items capture {"RESPONSE_ID":"/result/0/id"}',
      'GET /items/{{RESPONSE_ID}}',
      'as other GET /items/{{RESPONSE_ID}} expect contract,404',
    ]);
  });

  it('blocks the no-auth cases when no credential headers are configured', async () => {
    const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), { errors: { statuses: [401] } });
    const noAuth = sweepCases(contract, { credentials: [] }).filter((item) => item.case === 'no-auth');
    expect(noAuth.length).toBeGreaterThan(0);
    expect(new Set(noAuth.map((item) => item.blocked))).toEqual(new Set(['no credentials configured']));
  });

  it('gives no negative case without a declared status for it', async () => {
    const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), {});
    const kinds = new Set(sweepCases(contract, { credentials: ['self'] }).map((item) => item.case));
    // The fixture spec declares 404 and 422, and no 401 or 403.
    expect([...kinds].sort()).toEqual(['invalid-input', 'missing-id', 'ok', 'other-user', 'repeat-delete']);
  });
});
