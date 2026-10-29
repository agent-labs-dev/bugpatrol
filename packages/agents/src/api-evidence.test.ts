import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixtureApi, fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import { buildContract, loadSpec, requestPolicy } from '@bugpatrol/contract';
import { parseConfig, paths } from '@bugpatrol/core';
import { ApiDriver, Pacer } from '@bugpatrol/drivers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSession } from './session.js';
import { explorerTools } from './tools/explorer.js';
import { judgeTools } from './tools/judge.js';
import type { ToolResult } from './types.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

/** The fixture answers a login with this token: the secret that must stay out of every record. */
const PLANTED = 'fixture-token-a';

let root: string;
let fixture: FixtureApi;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugpatrol-api-evidence-'));
  fixture = await startFixtureApi();
});
afterEach(async () => {
  await fixture.close();
  await rm(root, { recursive: true, force: true });
});

async function explorer() {
  const workspace = new Workspace(root);
  const record = await workspace.startSession('explorer');
  const vars = new Vars();
  // The spec leaves out the login, and a URL outside the contract can only read.
  const doc = await loadSpec({ file: fixtureSpecPath });
  doc.paths['/auth/login'] = { post: { responses: {} } };
  const driver = new ApiDriver({
    url: fixture.url,
    credentials: { self: {} },
    policy: requestPolicy(buildContract(doc, {}), {
      url: fixture.url,
      methods: ['GET', 'POST'],
      deny: [],
      disposable: false,
    }),
    pacer: new Pacer({ perMinute: 60_000 }),
    timeoutMs: 2000,
    redact: (value) => vars.redact(value) as string,
  });
  await driver.connect();
  const session = new AgentSession(
    root,
    parseConfig({ version: 1, app: { platform: 'api', connect: { url: fixture.url } } }),
    vars,
    record.id,
    'explorer',
    driver,
  );
  const tools = explorerTools(session);
  // As the model runtime does: each result goes to the session log.
  const call = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    const result = await tools.find((tool) => tool.name === name)!.run(input);
    session.emit({
      kind: 'tool-result',
      summary: result.meta?.summary ?? name,
      tool: name,
      output: result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
      screenshot: result.meta?.screenshot,
    });
    return result;
  };
  return { session, call, workspace };
}

describe('api evidence', () => {
  it('the enum has only the allowed methods', async () => {
    const { session } = await explorer();
    const request = explorerTools(session).find((tool) => tool.name === 'request')!;
    expect(request.inputSchema).toMatchObject({ properties: { method: { enum: ['GET', 'POST'] } } });
  });

  it('keeps a planted secret out of tool results, the session log, and exchange.json', async () => {
    const { session, call } = await explorer();
    const look = await call('look', {});
    expect(look.content).toEqual([{ type: 'text', text: expect.stringContaining('No request yet.') }]);
    const login = await call('request', { method: 'POST', url: '/auth/login', body: '{"user":"a"}' });
    expect(login.content.every((part) => part.type === 'text')).toBe(true);
    const text = login.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    expect(text).toContain('HTTP 200 OK');
    expect(text).toContain('"token": "[redacted]"');
    expect(login.meta?.screenshot).toMatch(/\.exchange\.json$/);

    const dir = paths.session(root, session.sessionId);
    const files = await readdir(dir);
    expect(files.some((file) => file.endsWith('.png'))).toBe(false);
    const exchanges = files.filter((file) => file.endsWith('.exchange.json'));
    expect(exchanges).toHaveLength(1);
    const records = [
      text,
      ...(await Promise.all(exchanges.map((file) => readFile(join(dir, file), 'utf8')))),
      await readFile(join(dir, 'events.jsonl'), 'utf8'),
    ];
    expect(records[1]).toContain('"status": 200');
    for (const record of records) expect(record).not.toContain(PLANTED);
  });

  it('gives the judge an http candidate as one text part and no image', async () => {
    const { session, call, workspace } = await explorer();
    await call('request', { method: 'GET', url: '/health' });
    const reported = await call('report_bug', {
      screen_id: 'unrecorded',
      title: 'Health reports the database down',
      what_is_wrong: 'GET /health says db is down with status 200.',
      expected: 'A 503, or db up.',
      severity: 'major',
      shows: 'down',
    });
    expect(reported.isError).toBeFalsy();
    const [candidate] = await workspace.readCandidates(session.sessionId);
    expect(candidate?.evidence.capture).toMatchObject({
      kind: 'http',
      exchange: { request: { method: 'GET', path: '/health' }, response: { status: 200 } },
    });

    const judge = new AgentSession(root, session.config, new Vars(), 'judge-session', 'judge');
    const view = judgeTools(judge, [session.sessionId], 'test').find((tool) => tool.name === 'view_candidate')!;
    const viewed = await view.run({ id: candidate!.id });
    expect(viewed.content).toHaveLength(1);
    expect(viewed.content[0]!.type).toBe('text');
    const shown = viewed.content[0]!.type === 'text' ? viewed.content[0]!.text : '';
    expect(shown).toContain('Health reports the database down');
    expect(shown).toContain('GET /health\n\nHTTP 200 OK');
    expect(shown).toContain('"db": "down"');
  });
});
