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

  it('hides a setup capture that the connect URL carries', { timeout: 30_000 }, async () => {
    const url = `${await slowServer(3000)}login?token=tok_secret`;
    const redact = (value: string) => value.replaceAll('tok_secret', '{{TOKEN}}');
    driver = new WebDriver({ url, viewport: { width: 640, height: 400 }, loadTimeoutMs: 500, redact });
    const failure = await driver.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect(String(failure)).toContain('token={{TOKEN}}');
    expect(String(failure)).not.toContain('tok_secret');
    expect((failure as Error).cause).toBeUndefined();
  });

  it('hides a setup capture when the app refuses the connection', { timeout: 30_000 }, async () => {
    const closed = await slowServer(0);
    await new Promise((done) => server!.close(done));
    server = undefined;
    const redact = (value: string) => value.replaceAll('tok_secret', '{{TOKEN}}');
    driver = new WebDriver({ url: `${closed}login?token=tok_secret`, viewport: { width: 640, height: 400 }, redact });
    const failure = await driver.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect(String(failure)).toContain('token={{TOKEN}}');
    expect(String(failure)).not.toContain('tok_secret');
  });
});

describe('viewports[].deviceScaleFactor', () => {
  it('captures at the scale factor and reports it', { timeout: 30_000 }, async () => {
    const url = await slowServer(0);
    driver = new WebDriver({ url, viewport: { width: 393, height: 852, deviceScaleFactor: 2 } });
    await driver.connect();
    const observation = await driver.observe();
    if (observation.capture.kind !== 'image') throw new Error('No screenshot');
    expect(observation.capture.png.readUInt32BE(16)).toBe(786);
    expect(observation.capture.png.readUInt32BE(20)).toBe(1704);
    expect(observation.viewport).toEqual({ width: 393, height: 852, scale: 2 });
  });
});
