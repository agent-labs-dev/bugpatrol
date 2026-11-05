import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { expect, it } from 'vitest';
import { runChecks } from './doctor.js';

it('does not require a prestarted server for a gate config that supplies run.command', async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
  const root = process.cwd();
  // This is the gate config shape produced by init --gate. The gate itself starts run.command.
  const config = parseConfig({
    version: 1,
    run: { command: 'npm run dev', url: `http://127.0.0.1:${port}` },
  });
  const checks = await runChecks(
    root,
    { path: join(root, '.bugpatrol', 'bugpatrol.yml'), config },
    { chromium: () => undefined },
  );
  expect(checks.filter((check) => check.name === 'url' && !check.ok && check.fatal)).toEqual([]);
});
