import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigError } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiElement } from './types.js';
import { WebDriver } from './web.js';

const servers: Server[] = [];
const drivers: WebDriver[] = [];

/** Serves the HTML that `html` returns, or a 302 when it returns `{ redirect }`. */
async function serve(html: (request: IncomingMessage) => string | { redirect: string }): Promise<string> {
  const server = createServer((request, response) => {
    const body = html(request);
    if (typeof body === 'string') {
      response.setHeader('content-type', 'text/html');
      response.end(body);
    } else {
      response.writeHead(302, { location: body.redirect });
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function driver(url: string, allowedOrigins: string[] = []): WebDriver {
  const created = new WebDriver({ url, viewport: { width: 640, height: 400 }, allowedOrigins });
  drivers.push(created);
  return created;
}

async function element(web: WebDriver, name: string): Promise<UiElement> {
  const found = (await web.observe()).elements.find((each) => each.name === name);
  if (!found) throw new Error(`No element named ${name}`);
  return found;
}

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((each) => each.close()));
  await Promise.all(servers.splice(0).map((each) => new Promise((done) => each.close(done))));
});

describe('the web driver stays on the app origin', () => {
  it('refuses to start when the app URL redirects to another origin', { timeout: 30_000 }, async () => {
    const other = await serve(() => '<title>Other app</title>');
    const app = await serve((request) => ({ redirect: `${other}${request.url}` }));
    const failure = await driver(app)
      .connect()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ConfigError);
    expect(String(failure)).toContain(app);
    expect(String(failure)).toContain(other);
    expect(String(failure)).toContain('allowedOrigins');
  });

  it('starts on an allowed origin that the app URL redirects to', { timeout: 30_000 }, async () => {
    const signIn = await serve(() => '<title>Sign in</title>');
    const app = await serve(() => ({ redirect: `${signIn}/` }));
    const web = driver(app, [signIn]);
    await web.connect();
    const observation = await web.observe();
    expect(observation.location).toBe(`${signIn}/`);
    expect(observation.title).toBe('Sign in');
  });

  it('goes back to the app when a tap leaves it, and says so', { timeout: 30_000 }, async () => {
    const other = await serve(() => '<title>Other app</title>');
    const app = await serve(() => `<title>App</title><a href="${other}/elsewhere">Elsewhere</a>`);
    const web = driver(`${app}/start`);
    await web.connect();
    const result = await web.act({ kind: 'tap', ref: (await element(web, 'Elsewhere')).ref });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.error).toContain(`${other}/elsewhere`);
    expect(result.error).toContain('allowedOrigins');
    const observation = await web.observe();
    expect(observation.location).toBe(`${app}/start`);
    expect(observation.title).toBe('App');
  });

  it('can still go back past a page that left the app', { timeout: 30_000 }, async () => {
    const other = await serve(() => '<title>Other app</title>');
    const app = await serve((request) =>
      request.url === '/second'
        ? `<title>Second</title><a href="${other}/elsewhere">Elsewhere</a>`
        : '<title>First</title><a href="/second">Second</a>',
    );
    const web = driver(app);
    await web.connect();
    await web.act({ kind: 'tap', ref: (await element(web, 'Second')).ref });
    await web.act({ kind: 'tap', ref: (await element(web, 'Elsewhere')).ref });
    expect((await web.act({ kind: 'back' })).ok).toBe(true);
    expect((await web.observe()).title).toBe('First');
  });

  it('tells the explorer when the app redirects away on its own', { timeout: 30_000 }, async () => {
    const other = await serve(() => '<title>Other app</title>');
    let redirects = 1;
    const app = await serve((request) =>
      request.url === '/next' && redirects-- > 0
        ? `<title>Next</title><script>setTimeout(() => location.assign('${other}/later'), 300)</script>`
        : '<title>App</title><a href="/next">Next</a>',
    );
    const web = driver(app);
    await web.connect();
    expect((await web.act({ kind: 'tap', ref: (await element(web, 'Next')).ref })).ok).toBe(true);
    await expect.poll(async () => (await web.observe()).leftApp ?? [], { timeout: 5000 }).toEqual([`${other}/later`]);
    const observation = await web.observe();
    expect(observation.leftApp).toEqual([]);
    expect(new URL(observation.location).origin).toBe(app);
  });

  it('does not switch to a window on another origin', { timeout: 30_000 }, async () => {
    const other = await serve(() => '<title>Other app</title>');
    const app = await serve(() => `<title>App</title><a href="${other}/popup" target="_blank">Popup</a>`);
    const web = driver(app);
    await web.connect();
    expect((await web.act({ kind: 'tap', ref: (await element(web, 'Popup')).ref })).ok).toBe(true);
    await expect
      .poll(async () => (await web.observe()).windows?.some((window) => window.location.endsWith('/popup')))
      .toBe(true);
    const result = await web.act({ kind: 'window', match: '/popup' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Not switched');
    const observation = await web.observe();
    expect(observation.location).toBe(`${app}/`);
    expect(observation.windows?.find((window) => window.active)?.location).toBe(`${app}/`);
  });

  it('follows a sign-in round trip through an allowed origin', { timeout: 30_000 }, async () => {
    let app = '';
    const signIn = await serve(() => `<title>Sign in</title><a href="${app}/home">Continue</a>`);
    app = await serve((request) =>
      request.url === '/home' ? '<title>Home</title>' : `<title>Start</title><a href="${signIn}/login">Sign in</a>`,
    );
    const web = driver(app, [signIn]);
    await web.connect();
    expect((await web.act({ kind: 'tap', ref: (await element(web, 'Sign in')).ref })).ok).toBe(true);
    expect((await web.act({ kind: 'tap', ref: (await element(web, 'Continue')).ref })).ok).toBe(true);
    expect((await web.observe()).location).toBe(`${app}/home`);
  });
});
