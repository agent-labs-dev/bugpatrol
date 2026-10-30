import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlEvent } from '../types.js';
import { CuaDriver } from './driver.js';

const native = process.env.BUGPATROL_CUA_E2E === '1' ? describe : describe.skip;
native('isolated Cua desktop (real native input)', () => {
  let driver: CuaDriver | undefined;
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await driver?.close();
    await stop?.();
  });
  it('refreshes preview-invalidated tokens, pauses for takeover, and cleans up its app', async () => {
    let saved = '';
    const server = createServer(async (req, res) => {
      if (req.url === '/save') {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        saved = Buffer.concat(chunks).toString();
        res.end('saved');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        `<title>Bugpatrol native fixture</title><label>Name <input id="name"></label><button onclick="fetch('/save',{method:'POST',body:document.querySelector('input').value}).then(()=>document.querySelector('output').textContent='Saved '+document.querySelector('input').value)">Save</button><output>waiting</output>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    stop = () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No fixture port');
    const hostDisplay = process.env.DISPLAY,
      hostBus = process.env.DBUS_SESSION_BUS_ADDRESS;
    driver = new CuaDriver({
      deliveryMode: 'foreground',
      windowManager: process.env.BUGPATROL_CUA_WINDOW_MANAGER ?? 'openbox',
      command: process.env.BUGPATROL_CUA_COMMAND ?? 'cua-driver',
      launch: chromium.executablePath(),
      args: [
        '--user-data-dir={{PRIVATE_DIR}}/profile',
        '--force-renderer-accessibility',
        '--no-first-run',
        '--disable-gpu',
        `http://127.0.0.1:${address.port}`,
      ],
      windowTitle: 'Bugpatrol native fixture',
      viewport: { width: 1280, height: 900 },
      viewer: { enabled: true, port: 0, allowTakeover: true },
      redact: (value) => value,
    });
    const events: ControlEvent[] = [];
    driver.onControlEvent = (event) => events.push(event);
    await driver.connect();
    const appPid = driver.appProcessId!;
    const directory = driver.privateDirectory!;
    const view = new URL(driver.viewerUrl!);
    const origin = view.origin;
    const headers = {
      Authorization: `Bearer ${view.hash.slice(1)}`,
      'Content-Type': 'application/json',
      Origin: origin,
    };
    const post = (path: string, data: unknown) =>
      fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(data) });
    const observed = await driver.observe();
    expect(observed.capture.kind === 'image' && observed.capture.png.readUInt32BE(16)).toBe(observed.viewport.width);
    const name = observed.elements.find((element) => element.name === 'Name' && element.role === 'textbox');
    expect(name).toBeDefined();
    expect((await fetch(`${origin}/frame`, { headers })).status).toBe(200);
    const typedResult = await driver.act({ kind: 'type', ref: name!.ref, value: 'Native agent proof' });
    if (!typedResult.ok) throw new Error(typedResult.error);
    expect(typedResult.ok).toBe(true);
    const typed = await driver.observe();
    const save = typed.elements.find((element) => element.name === 'Save' && element.role === 'button');
    expect(await driver.act({ kind: 'tap', ref: save!.ref })).toMatchObject({ ok: true });
    await driver.settle();
    expect(saved).toBe('Native agent proof');
    expect(
      await driver.act({ kind: 'tap', locator: { role: 'button', name: 'Missing button', point: { x: 20, y: 20 } } }),
    ).toMatchObject({ ok: false, retryable: false });
    const ready = await driver.observe();
    const button = ready.elements.find((element) => element.role === 'button' && element.name === 'Save')!;
    expect(
      await driver.act({
        kind: 'tap',
        locator: { point: { x: button.box.x + button.box.width / 2, y: button.box.y + button.box.height / 2 } },
      }),
    ).toMatchObject({ ok: true, degraded: true });
    expect((await driver.observe()).elements.some((element) => element.name.includes('Saved Native agent proof'))).toBe(
      true,
    );
    expect((await post('/input', { kind: 'press', key: 'Return' })).status).toBe(409);
    expect((await post('/control', { owner: 'human' })).status).toBe(200);
    let finished = false;
    const queued = driver.act({ kind: 'press', key: 'Return' }).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(finished).toBe(false);
    expect((await post('/input', { kind: 'press', key: 'Tab' })).status).toBe(200);
    expect((await post('/control', { owner: 'agent' })).status).toBe(200);
    expect(await queued).toMatchObject({ ok: false, error: expect.stringContaining('look again') });
    await driver.observe();
    expect(await driver.act({ kind: 'wait', ms: 10 })).toMatchObject({ ok: true });
    expect(events.map((event) => event.kind)).toEqual(['control-change', 'human-action', 'control-change']);
    expect(process.env.DISPLAY).toBe(hostDisplay);
    expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBe(hostBus);
    await driver.close();
    await expect(access(directory)).rejects.toThrow();
    await expect
      .poll(
        () => {
          try {
            process.kill(appPid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 3000 },
      )
      .toBe(false);
    await expect(fetch(`${origin}/state`, { headers })).rejects.toThrow();
  }, 90000);
});
