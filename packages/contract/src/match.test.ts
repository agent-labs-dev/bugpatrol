import { describe, expect, it } from 'vitest';
import { buildContract } from './contract.js';

const { match } = buildContract(
  {
    openapi: '3.1.0',
    paths: {
      '/items/{id}': { get: { responses: {} } },
      '/items/export': { get: { responses: {} } },
      '/items/{id}/files/{name}.json': { get: { responses: {} } },
      '/items/{id}/files/{file}': { get: { responses: {} } },
    },
  },
  {},
);

const keyOf = (method: string, url: string) => match(method, url)?.key;

describe('Contract.match', () => {
  it('strips the query', () => {
    expect(keyOf('GET', '/items/42?x=1')).toBe('GET /items/{id}');
    expect(keyOf('get', 'http://127.0.0.1:8000/items/42?x=1#top')).toBe('GET /items/{id}');
  });

  it('matches nothing for an extra segment, another method, or an empty param', () => {
    expect(keyOf('GET', '/items/42/x')).toBeUndefined();
    expect(keyOf('DELETE', '/items/42')).toBeUndefined();
    expect(keyOf('GET', '/items/')).toBeUndefined();
  });

  it('prefers a literal segment over a param', () => {
    expect(keyOf('GET', '/items/export')).toBe('GET /items/export');
    expect(keyOf('GET', '/items/files/files/a.json')).toBe('GET /items/{id}/files/{name}.json');
    expect(keyOf('GET', '/items/1/files/a.txt')).toBe('GET /items/{id}/files/{file}');
  });

  it('compares literals case-sensitively', () => {
    expect(keyOf('GET', '/items/Export')).toBe('GET /items/{id}');
    expect(keyOf('GET', '/Items/42')).toBeUndefined();
  });

  it('decodes %2F one time, inside its segment', () => {
    expect(keyOf('GET', '/items/a%2Fb')).toBe('GET /items/{id}');
    expect(keyOf('GET', '/items%2Fexport')).toBeUndefined();
    expect(keyOf('GET', '/items/%65xport')).toBe('GET /items/export');
  });
});
