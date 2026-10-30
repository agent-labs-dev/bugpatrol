import { describe, expect, it } from 'vitest';
import { formatHttpExchange, httpBlock } from './http.js';
import type { HttpExchange } from './types/evidence.js';

const at = '2026-10-29T12:00:00.000Z';

describe('formatHttpExchange', () => {
  it('writes a 200 exchange as request, status line, headers, and body', () => {
    const exchange: HttpExchange = {
      request: {
        method: 'POST',
        path: '/items?dry=1',
        headers: { 'content-type': 'application/json', authorization: '[redacted]' },
        body: '{\n  "name": "Gamma"\n}',
      },
      response: {
        status: 201,
        headers: { 'content-type': 'application/json', location: '/items/3' },
        contentType: 'application/json',
        body: '{\n  "result": {\n    "id": "3"\n  }\n}',
        bytes: 22,
      },
      latencyMs: 12,
      at,
    };
    expect(formatHttpExchange(exchange)).toBe(
      [
        'POST /items?dry=1',
        'content-type: application/json',
        'authorization: [redacted]',
        '',
        '{',
        '  "name": "Gamma"',
        '}',
        '',
        'HTTP 201 Created (12 ms)',
        'content-type: application/json',
        'location: /items/3',
        '',
        '{',
        '  "result": {',
        '    "id": "3"',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('writes a 500 exchange without a request body', () => {
    const exchange: HttpExchange = {
      request: { method: 'GET', path: '/items/0', headers: {} },
      response: {
        status: 500,
        headers: { 'content-type': 'application/json' },
        contentType: 'application/json',
        body: '{"error":{"code":"internal","message":"Division by zero."}}',
        bytes: 59,
      },
      latencyMs: 3,
      at,
    };
    expect(formatHttpExchange(exchange)).toBe(
      [
        'GET /items/0',
        '',
        'HTTP 500 Internal Server Error (3 ms)',
        'content-type: application/json',
        '',
        '{"error":{"code":"internal","message":"Division by zero."}}',
      ].join('\n'),
    );
  });

  it('writes a request that got no response, and a body that was too large', () => {
    const request = { method: 'GET' as const, path: '/export', headers: {} };
    expect(formatHttpExchange({ request, error: 'TimeoutError', latencyMs: 300, at })).toBe(
      'GET /export\n\nNo response after 300 ms: TimeoutError',
    );
    expect(
      formatHttpExchange({
        request,
        response: { status: 200, headers: {}, contentType: null, body: '', bytes: 2097164, tooLarge: true },
        latencyMs: 40,
        at,
      }),
    ).toBe('GET /export\n\nHTTP 200 OK (40 ms)\n\n[body not kept: 2097164 bytes, over the read limit]');
  });

  it('cuts a body over the cap and says so', () => {
    const body = 'x'.repeat(9000);
    const exchange: HttpExchange = {
      request: { method: 'GET', path: '/big', headers: {} },
      response: { status: 200, headers: {}, contentType: 'text/plain', body, bytes: 9000 },
      latencyMs: 1,
      at,
    };
    const text = formatHttpExchange(exchange);
    expect(text).toContain(`\n${'x'.repeat(8000)}\n[body cut: 8000 of 9000 characters shown]`);
    expect(text).not.toContain('x'.repeat(8001));
    expect(formatHttpExchange(exchange, { maxBodyChars: 10 }).split('\n').slice(-2)).toEqual([
      'x'.repeat(10),
      '[body cut: 10 of 9000 characters shown]',
    ]);
    expect(formatHttpExchange(exchange, { maxBodyChars: 9000 })).not.toContain('[body cut');
  });

  it('fences a markdown block longer than any backticks in the body', () => {
    const block = httpBlock({
      request: { method: 'GET', path: '/md', headers: {} },
      response: { status: 200, headers: {}, contentType: 'text/markdown', body: '```js\nx\n```', bytes: 12 },
      latencyMs: 1,
      at,
    });
    expect(block.startsWith('````http\nGET /md\n')).toBe(true);
    expect(block.endsWith('\n```\n````')).toBe(true);
  });
});
