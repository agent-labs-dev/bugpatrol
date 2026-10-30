import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureApi, fixtureSpecPath, startFixtureApi } from './index.js';

let api: FixtureApi;
beforeEach(async () => {
  api = await startFixtureApi({ perSecond: 100 });
});
afterEach(() => api.close());

async function login(user: string): Promise<Record<string, string>> {
  const response = await fetch(`${api.url}/auth/login`, { method: 'POST', body: JSON.stringify({ user }) });
  const { result } = await response.json();
  return { authorization: `Bearer ${result.token}`, 'x-workspace-id': result.workspaceId };
}

describe('the fixture API', () => {
  it('each planted bug is reachable', async () => {
    const a = await login('a');
    const b = await login('b');
    const request = (path: string, init: RequestInit = {}, headers = a) =>
      fetch(`${api.url}${path}`, { ...init, headers: { ...headers, 'content-type': 'application/json' } });

    expect((await request('/items/0')).status).toBe(500);
    const list = await (await request('/items')).json();
    expect(list.result[0]).toHaveProperty('internal_note');
    expect((await request('/items/1', {}, b)).status).toBe(403);
    expect((await request('/items/1', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/items/1', { method: 'DELETE' })).status).toBe(500);
    const bad = await request('/items', { method: 'POST', body: '{}' });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toHaveProperty('error.code', 'invalid_body');
    expect(await (await request('/health')).json()).toEqual({ status: 'ok', db: 'down' });
    expect((await request('/items/999')).status).toBe(404);
    const spec = JSON.parse(await readFile(fixtureSpecPath, 'utf8'));
    expect(Object.keys(spec.paths['/items/{id}'].get.responses)).toEqual(['200']);
  });

  it('each control behaves', async () => {
    const a = await login('a');
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${api.url}${path}`, { ...init, headers: { ...a, 'content-type': 'application/json' } });

    const created = await request('/items', { method: 'POST', body: JSON.stringify({ name: 'Gamma' }) });
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBeNull();
    expect((await created.json()).result).toEqual({ id: '3', name: 'Gamma', owner: 'a', workspace: 'ws-a' });
    expect((await request('/items/3', { method: 'PATCH', body: '{}' })).status).toBe(422);
    expect((await fetch(`${api.url}/items`)).status).toBe(401);

    const started = Date.now();
    expect((await (await request('/search?q=Gam')).json()).result).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(790);

    expect((await (await request('/export')).text()).length).toBeGreaterThan(2 * 1024 * 1024);
    expect((await request('/admin/wipe', { method: 'POST' })).status).toBe(204);
    expect((await request('/items/3')).status).toBe(404);
    expect(api.hits().filter((hit) => hit.path === '/admin/wipe')).toHaveLength(1);

    const events = await fetch(`${api.url}/events`);
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"tick":0}\n\n');
    await reader.cancel();

    api.setCommit('abc1234');
    expect(await (await request('/version')).json()).toEqual({ result: { commit: 'abc1234' } });
    expect(await (await request('/version/fleet')).json()).toEqual({ result: [{ commit: 'abc1234' }] });
    api.setFleet(['abc1234', 'def5678']);
    expect((await (await request('/version/fleet')).json()).result).toEqual([
      { commit: 'abc1234' },
      { commit: 'def5678' },
    ]);

    api.failOnce('GET', '/items');
    expect((await request('/items')).status).toBe(500);
    expect((await request('/items')).status).toBe(200);

    const spec = await (await request('/openapi.json')).json();
    expect(spec.servers).toEqual([{ url: 'https://prod.invalid' }]);
    expect(spec.paths['/notify'].post['x-bugpatrol-skip']).toBe(true);
    expect(spec.paths['/admin/wipe'].post.operationId).toBe('wipeItems');
    expect(spec.paths['/auth/login']).toBeUndefined();
    const big = await (await request('/openapi-big.json')).text();
    expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(JSON.parse(big).paths).toEqual(spec.paths);
  });

  it('answers a burst over the rate limit with 429 and Retry-After', async () => {
    const limited = await startFixtureApi({ perSecond: 3 });
    try {
      const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${limited.url}/health`)));
      const throttled = responses.filter((response) => response.status === 429);
      expect(throttled).toHaveLength(2);
      expect(throttled[0]!.headers.get('retry-after')).toBe('1');
    } finally {
      await limited.close();
    }
  });

  it('hits() records method and path', async () => {
    await fetch(`${api.url}/search?q=x`, { method: 'GET' });
    await fetch(`${api.url}/items/7`, { method: 'DELETE' });
    expect(api.hits()).toEqual([
      { method: 'GET', path: '/search' },
      { method: 'DELETE', path: '/items/7' },
    ]);
  });
});
