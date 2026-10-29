import { fixtureSpecPath } from '@bugpatrol/api-fixture';
import { ConfigError, HTTP_METHODS, type HttpMethod } from '@bugpatrol/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildContract, type Contract } from './contract.js';
import { loadSpec } from './load.js';
import { requestPolicy } from './policy.js';

let contract: Contract;
beforeAll(async () => {
  contract = buildContract(await loadSpec({ file: fixtureSpecPath }), {});
});

const policy = (url: string, connect: { methods?: HttpMethod[]; deny?: string[]; disposable?: boolean } = {}) =>
  requestPolicy(contract, { url, methods: [...HTTP_METHODS], deny: [], disposable: false, ...connect });

describe('requestPolicy', () => {
  it('127.0.0.2 and [::1] allow writes', () => {
    for (const url of ['http://127.0.0.2:8000', 'http://[::1]:8000', 'http://localhost:3000']) {
      const local = policy(url);
      expect(local.writesAllowed).toBe(true);
      expect(local.allowedMethods).toEqual([...HTTP_METHODS]);
      expect(local.check('POST', '/items')).toMatchObject({ ok: true, endpoint: { key: 'POST /items' } });
    }
  });

  it('api.nebula-dev.ai is read-only without disposable', () => {
    const shared = policy('https://api.nebula-dev.ai');
    expect(shared.writesAllowed).toBe(false);
    expect(shared.allowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS']);
    expect(shared.check('DELETE', '/items/1')).toMatchObject({ ok: false, readOnly: true });
    expect(shared.check('GET', '/items/1')).toMatchObject({ ok: true, endpoint: { key: 'GET /items/{id}' } });
    expect(policy('https://api.nebula-dev.ai', { disposable: true }).check('DELETE', '/items/1').ok).toBe(true);
    // A url with a placeholder that did not resolve is not loopback.
    expect(policy('http://127.0.0.1:${PORT}').writesAllowed).toBe(false);
  });

  it('deny matches /admin/** on the template', () => {
    const guarded = policy('http://127.0.0.1:8000', { deny: ['/admin/**', 'DELETE /items/*'] });
    expect(guarded.check('POST', '/admin/wipe')).toEqual({ ok: false, reason: 'app.connect.deny has /admin/**' });
    expect(guarded.check('DELETE', '/items/7')).toEqual({ ok: false, reason: 'app.connect.deny has DELETE /items/*' });
    // The decoded path is /items/a/b, but the endpoint is still DELETE /items/{id}.
    expect(guarded.check('DELETE', '/items/a%2Fb')).toMatchObject({
      ok: false,
      reason: 'app.connect.deny has DELETE /items/*',
    });
    expect(guarded.check('PATCH', '/items/7').ok).toBe(true);
    expect(() => policy('http://127.0.0.1:8000', { deny: ['admin/**'] })).toThrow(ConfigError);
  });

  it('%2F does not escape a deny glob', () => {
    const guarded = policy('http://127.0.0.1:8000', { deny: ['/admin/**'] });
    for (const url of ['/admin%2Fwipe', '/admin%2fwipe', 'http://127.0.0.1:8000/admin/%77ipe', '/a/../admin/wipe'])
      for (const method of ['GET', 'POST'] as const) expect(guarded.check(method, url).ok).toBe(false);
  });

  it('skips x-bugpatrol-skip operations, and lets a URL outside the contract only read', () => {
    const local = policy('http://127.0.0.1:8000');
    expect(local.check('POST', '/notify')).toEqual({ ok: false, reason: 'the spec marks it x-bugpatrol-skip' });
    expect(local.check('GET', '/openapi.json')).toEqual({ ok: true });
    expect(local.check('POST', '/auth/login')).toEqual({ ok: false, reason: 'the contract has no such endpoint' });
  });

  it('methods narrows the policy', () => {
    const narrow = policy('http://127.0.0.1:8000', { methods: ['GET', 'POST'] });
    expect(narrow.allowedMethods).toEqual(['GET', 'POST']);
    expect(narrow.check('DELETE', '/items/1')).toEqual({
      ok: false,
      reason: 'app.connect.methods does not have DELETE',
    });
    expect(policy('https://api.example.com', { methods: ['GET', 'POST'] }).allowedMethods).toEqual(['GET']);
  });
});
