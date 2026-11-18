import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { CliDriver } from '@bugpatrol/drivers';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AgentSession } from './session.js';
import { explorerTools } from './tools/explorer.js';
import { judgeTools } from './tools/judge.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugpatrol-terminal-evidence-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('gives the judge the whole output of the command a terminal candidate cites, and the colours of its cells', {
  timeout: 30_000,
}, async () => {
  const workspace = new Workspace(root);
  const record = await workspace.startSession('explorer');
  const vars = new Vars();
  const driver = new CliDriver({ cwd: root, timeoutMs: 10_000, cols: 40, rows: 6 });
  await driver.connect();
  try {
    const config = parseConfig({ version: 1, app: { platform: 'cli' } });
    const session = new AgentSession(root, config, vars, record.id, 'explorer', driver);
    const tools = explorerTools(session);
    const call = (name: string, input: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.run(input);
    // An early failure, then enough passing cases that the 6-row screenshot shows only the last of them.
    await call('run_command', {
      command: `echo 'case empty-task: cost 0.0000672 (expected 0)'; for i in $(seq 1 30); do echo "case $i: ok"; done`,
    });
    const reported = await call('report_bug', {
      screen_id: 'unrecorded',
      title: 'An empty task invokes the model',
      what_is_wrong: 'The empty task costs 0.0000672.',
      expected: 'No model call and no cost.',
      severity: 'major',
      shows: 'cost 0.0000672',
    });
    expect(reported.isError).toBeFalsy();
    const [candidate] = await workspace.readCandidates(record.id);
    expect(candidate?.evidence.capture).toMatchObject({
      kind: 'image',
      terminal: expect.stringMatching(/\.terminal\.txt$/),
    });

    const judge = new AgentSession(root, config, new Vars(), 'judge-session', 'judge');
    const view = judgeTools(judge, [record.id], 'test').find((tool) => tool.name === 'view_candidate')!;
    const viewed = await view.run({ id: candidate!.id });
    expect(viewed.content.map((part) => part.type)).toEqual(['text', 'image', 'text']);
    const transcript = viewed.content[2]!.type === 'text' ? viewed.content[2]!.text : '';
    expect(transcript).toContain('case empty-task: cost 0.0000672 (expected 0)');
    expect(transcript).toContain('case 30: ok');
    // The colours of the screenshot's cells, which show only the last rows.
    expect(transcript).toMatch(/row 5: 1-11 fg #d4d4d4 bg #1e1e1e "case 30: ok"/);
  } finally {
    await driver.close();
  }
});

it('offers a terminal app no error check, which only console and network errors can meet', {
  timeout: 30_000,
}, async () => {
  const workspace = new Workspace(root);
  const record = await workspace.startSession('explorer');
  const driver = new CliDriver({ cwd: root, timeoutMs: 10_000, cols: 80, rows: 10 });
  await driver.connect();
  try {
    const config = parseConfig({ version: 1, app: { platform: 'cli' } });
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    const tools = explorerTools(session);
    const report = tools.find((tool) => tool.name === 'report_bug')!;
    expect(Object.keys((report.inputSchema as { properties: object }).properties)).not.toContain('error');
    expect(report.description).toContain('stack trace');
    await tools
      .find((tool) => tool.name === 'run_command')!
      .run({
        command: `node -e 'undefined.toString()'`,
      });
    const reported = await report.run({
      screen_id: 'unrecorded',
      title: 'The command crashes',
      what_is_wrong: 'It prints a TypeError stack trace.',
      expected: 'A clear message.',
      severity: 'major',
      shows: 'TypeError: Cannot read properties of undefined',
    });
    expect(reported.isError).toBeFalsy();
  } finally {
    await driver.close();
  }
});
