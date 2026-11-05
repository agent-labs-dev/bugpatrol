import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfrastructureError } from '@bugpatrol/core';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { appPage, ElectronDriver } from './electron.js';

function createProfileDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bugpatrol-electron-'));
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    throw new Error('Could not allocate a port');
  }
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('ElectronDriver page choice', () => {
  let driver: ElectronDriver | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let profileDir: string | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    const activeDriver = driver;
    const activeBrowser = browser;
    const activeServer = server;
    const activeProfileDir = profileDir;
    driver = undefined;
    browser = undefined;
    server = undefined;
    profileDir = undefined;
    await activeDriver?.close().catch(() => {});
    await activeBrowser?.close().catch(() => {});
    await new Promise<void>((resolve) => (activeServer ? activeServer.close(() => resolve()) : resolve()));
    if (activeProfileDir) await rm(activeProfileDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: 'data first then http',
      candidates: [
        { url: 'data:text/html,splash', visible: true, focused: false },
        { url: 'http://app.test', visible: false, focused: false },
      ],
      expected: 1,
    },
    { name: 'app scheme is kept', candidates: [{ url: 'app://index', visible: true, focused: true }], expected: 0 },
    {
      name: 'focused visible beats visible',
      candidates: [
        { url: 'http://visible.test', visible: true, focused: false },
        { url: 'http://focused.test', visible: true, focused: true },
      ],
      expected: 1,
    },
    {
      name: 'visible beats first remaining',
      candidates: [
        { url: 'http://first.test', visible: false, focused: false },
        { url: 'http://visible.test', visible: true, focused: false },
      ],
      expected: 1,
    },
    {
      name: 'first remaining is the fallback',
      candidates: [
        { url: 'http://first.test', visible: false, focused: false },
        { url: 'http://second.test', visible: false, focused: false },
      ],
      expected: 0,
    },
    {
      name: 'a focused remote page loses to a visible app page',
      candidates: [
        { url: 'https://accounts.example.com/oauth', visible: true, focused: true },
        { url: 'app://index', visible: true, focused: false },
      ],
      expected: 1,
    },
    {
      name: 'a visible remote page beats a hidden app page',
      candidates: [
        { url: 'https://app.vendor.com/', visible: true, focused: true },
        { url: 'file:///tray.html', visible: false, focused: false },
      ],
      expected: 0,
    },
    {
      name: 'any 127/8 address is a loopback app page',
      candidates: [
        { url: 'https://accounts.example.com/oauth', visible: true, focused: true },
        { url: 'http://127.0.0.2:5173/', visible: true, focused: false },
      ],
      expected: 1,
    },
  ] as { name: string; candidates: Parameters<typeof appPage>[0]; expected: number }[])(
    '$name',
    ({ candidates, expected }) => {
      expect(appPage(candidates)).toBe(expected);
    },
  );

  it.each([
    'data:text/html,splash',
    'about:blank',
    'blob:https://app.test/id',
    'javascript:alert(1)',
    'view-source:https://app.test/',
    'chrome://settings',
    'chrome-error://chromewebdata/',
    'chrome-extension://extension-id/page.html',
    'chrome-untrusted://terminal/',
    'devtools://devtools/bundled/inspector.html',
    'not a URL',
  ])('rejects browser-owned or invalid URL %s', (url) => {
    expect(appPage([{ url, visible: true, focused: true }])).toBeUndefined();
  });

  it('chooses the loopback app page after a data splash page', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>App</title>');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start app server');
    const appUrl = `http://127.0.0.1:${address.port}/`;

    const cdpPort = await freePort();
    profileDir = await createProfileDir();
    browser = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: [`--remote-debugging-port=${cdpPort}`, '--disable-gpu'],
    });
    await browser.pages()[0]!.goto('data:text/html,splash');
    await browser.newPage().then((page) => page.goto(appUrl));
    await browser.pages()[0]!.bringToFront();

    driver = new ElectronDriver(`http://127.0.0.1:${cdpPort}`);
    await driver.connect();

    expect((await driver.observe()).location).toBe(appUrl);
  });

  it('throws an infrastructure error when only browser-owned pages exist', async () => {
    const cdpPort = await freePort();
    profileDir = await createProfileDir();
    browser = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: [`--remote-debugging-port=${cdpPort}`, '--disable-gpu'],
    });
    const dataUrl = 'data:text/html,splash';
    await browser.pages()[0]!.goto(dataUrl);
    await browser.newPage();

    // The driver waits for an app window to open before it gives up.
    driver = new ElectronDriver(`http://127.0.0.1:${cdpPort}`, [], 500);
    const error = await driver.connect().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(InfrastructureError);
    // Each page is named by scheme only: a data: URL's body is the page and stays out of the error.
    expect((error as Error).message).toContain('data:');
    expect((error as Error).message).not.toContain('splash');
    expect((error as Error).message).toContain('about:');
  });
});
