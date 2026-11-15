import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ApiDriver, responseCaptures } from './api.js';
import { Pacer } from './api-pacer.js';

describe('API response captures', () => {
  it('keeps an owner resource id but rejects credential fields and parents', () => {
    const body = JSON.stringify({
      browser_session: { id: 'sess_123' },
      token: 'secret',
      credentials: { id: 'secret' },
      nested: { id: 'eyJheadersx.payloadxx.signaturexx' },
    });
    expect(responseCaptures(200, body, { RESPONSE_SESSION: '/browser_session/id' })).toEqual({
      RESPONSE_SESSION: 'sess_123',
    });
    expect(() => responseCaptures(200, body, { RESPONSE_TOKEN: '/token' })).toThrow('credential field');
    expect(() => responseCaptures(200, body, { RESPONSE_CREDENTIALS: '/credentials' })).toThrow('credential field');
    expect(() => responseCaptures(200, body, { RESPONSE_CREDENTIAL_ID: '/credentials/id' })).toThrow(
      'credential field',
    );
    expect(() => responseCaptures(200, body, { RESPONSE_JWT: '/nested/id' })).toThrow('credential field');
  });

  it('sends binary multipart with CRLF boundaries unchanged', async () => {
    const seen: Buffer[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        seen.push(Buffer.concat(chunks));
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const driver = new ApiDriver({
        url: origin,
        credentials: { self: {} },
        policy: { allowedMethods: ['POST'], check: () => ({ ok: true }) } as never,
        pacer: new Pacer({ perMinute: 60_000 }),
        timeoutMs: 2_000,
        redact: (value) => value,
      });
      const body = '--b\\r\\nContent-Disposition: form-data; name="file"\\r\\n\\r\\n\\x00\\r\\n--b--\\r\\n';
      const result = await driver.act({
        kind: 'request',
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'multipart/form-data; boundary=b' },
        body,
      });
      expect(result.ok).toBe(true);
      expect(seen[0]).toEqual(Buffer.from(body));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it('protects credential ancestors, JWT resource values, and configured secrets', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
  expect(() =>
    responseCaptures(200, JSON.stringify({ credentials: { browser_session: { id: 'private' } } }), {
      RESPONSE_SESSION: '/credentials/browser_session/id',
    }),
  ).toThrow('credential field');
  expect(() =>
    responseCaptures(200, JSON.stringify({ browser_session: { id: jwt } }), {
      RESPONSE_SESSION: '/browser_session/id',
    }),
  ).toThrow('credential field');
  expect(() =>
    responseCaptures(
      200,
      JSON.stringify({ browser_session: { id: 'configured-secret' } }),
      {
        RESPONSE_SESSION: '/browser_session/id',
      },
      (value) => value.replaceAll('configured-secret', '[redacted]'),
    ),
  ).toThrow('credential field');
  expect(
    responseCaptures(200, JSON.stringify({ file: { id: 'file_123' } }), {
      RESPONSE_FILE: '/file/id',
    }),
  ).toEqual({ RESPONSE_FILE: 'file_123' });
});
