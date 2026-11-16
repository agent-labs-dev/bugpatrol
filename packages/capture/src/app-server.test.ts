import { once } from 'node:events';
import { createServer } from 'node:http';
import type { BugpatrolConfig } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { startApp } from './app-server.js';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe('app server lifecycle', () => {
  it('kills a TERM-ignoring descendant after the shell exits', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const config = {
      run: {
        command: `node -e "require('http').createServer((_,r)=>r.end('ok')).listen(${port}); process.on('SIGTERM',()=>{})" & sleep 1`,
        url,
        ready: { selectors: [], timeoutMs: 10_000, forbidConsoleErrors: true },
        seeds: [],
      },
      determinism: { timezone: 'UTC' },
    } as unknown as BugpatrolConfig;

    const replacement = createServer((_, response) => response.end('replacement'));
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    try {
      app = await startApp(config, { cwd: process.cwd(), reuseExisting: false });
      expect(await (await fetch(url)).text()).toBe('ok');
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await app.stop();
      app = undefined;

      await expect(fetch(url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
      replacement.listen(port, '127.0.0.1');
      await once(replacement, 'listening');
    } finally {
      if (app) await app.stop();
      if (replacement.listening) await new Promise<void>((resolve) => replacement.close(() => resolve()));
    }
  }, 20_000);

  it('stops a well-behaved server without waiting for the grace window', async () => {
    const port = await freePort();
    const config = {
      run: {
        command: `node -e "require('http').createServer((_,r)=>r.end('ok')).listen(${port})"`,
        url: `http://127.0.0.1:${port}`,
        ready: { selectors: [], timeoutMs: 10_000, forbidConsoleErrors: true },
        seeds: [],
      },
      determinism: { timezone: 'UTC' },
    } as unknown as BugpatrolConfig;
    const app = await startApp(config, { cwd: process.cwd(), reuseExisting: false });
    const started = Date.now();
    await app.stop();
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);
});
