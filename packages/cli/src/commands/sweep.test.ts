import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode, parseConfig, paths } from '@bugpatrol/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSweepFlags, runSweepCommand } from './sweep.js';

const spec = {
  openapi: '3.1.0',
  paths: {
    '/items': {
      get: { responses: { '200': { description: 'ok' }, '404': { description: 'no' } } },
      post: { responses: { '201': { description: 'made' } } },
    },
    '/admin/reset': { post: { responses: { '204': { description: 'done' } } } },
  },
};

describe('bugpatrol sweep', () => {
  let root: string;
  let server: Server;
  let hits: number;
  let url: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bugpatrol-sweep-cli-'));
    await writeFile(join(root, 'openapi.json'), JSON.stringify(spec));
    hits = 0;
    server = createServer((_, response) => {
      hits += 1;
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  });

  it('reads its flags', () => {
    expect(parseSweepFlags(['--json', '--max-requests', '5', '--dry-run'])).toEqual({
      json: true,
      dryRun: true,
      maxRequests: 5,
    });
    expect(() => parseSweepFlags(['--max-requests', '0'])).toThrow('positive integer');
  });

  it('a dry run lists the plan, sends nothing, and allows no denied operation', async () => {
    const config = parseConfig({
      version: 1,
      app: { platform: 'api', connect: { url, spec: 'openapi.json', deny: ['/admin/**'] } },
    });
    const lines: string[] = [];
    const code = await runSweepCommand(['--dry-run', '--json'], root, config, (line) => lines.push(line));
    expect(code).toBe(ExitCode.Clean);
    const plan = JSON.parse(lines.join('\n'));
    expect(plan.planned.map((item: { case: string }) => item.case)).toEqual(['GET /items ok', 'POST /items ok']);
    expect(plan.skipped).toEqual([{ key: 'POST /admin/reset ok', reason: 'app.connect.deny has /admin/**' }]);
    expect(hits).toBe(0);
    expect(existsSync(paths.coverage(root))).toBe(false);
  });
});
