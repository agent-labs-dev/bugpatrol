import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InfrastructureError } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebDriver } from './web.js';

let server: Server | undefined;
let driver: WebDriver | undefined;

/** A dev server that answers its first page only after `delayMs`, as one that builds the app on that request. */
async function slowServer(delayMs: number): Promise<string> {
  server = createServer((_request, response) => {
    setTimeout(() => response.writeHead(200, { 'content-type': 'text/html' }).end('<title>App</title>'), delayMs);
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

afterEach(async () => {
  await driver?.close();
  server?.closeAllConnections();
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  driver = undefined;
  server = undefined;
});

describe('the first page load', () => {
  it('waits as long as connect.loadTimeoutMs allows', { timeout: 30_000 }, async () => {
    const url = await slowServer(1500);
    driver = new WebDriver({ url, viewport: { width: 640, height: 400 }, loadTimeoutMs: 10_000 });
    await driver.connect();
    expect((await driver.observe()).title).toBe('App');
  });

  it('stops at the limit and names the setting that raises it', { timeout: 30_000 }, async () => {
    const url = await slowServer(3000);
    driver = new WebDriver({ url, viewport: { width: 640, height: 400 }, loadTimeoutMs: 500 });
    const failure = await driver.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect(String(failure)).toContain('app.connect.loadTimeoutMs');
    expect(String(failure)).toContain('0.5s');
  });
});
