import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixProposal, type Issue, parseConfig } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Gh } from '../github.js';
import type { Runtime, Tool } from '../types.js';
import { Workspace } from '../workspace.js';
import { runPublisher } from './publish.js';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});
async function fixture(severity: Issue['severity'] = 'major', status: Issue['status'] = 'new') {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-publish-'));
  roots.push(root);
  const workspace = new Workspace(root);
  const issue: Issue = {
    version: 1,
    id: 'iss_1',
    fingerprint: 'fp',
    title: 'Broken screen',
    body: 'What happened',
    severity,
    status,
    candidateIds: [],
    evidence: { capture: { kind: 'image', screenshot: 'shot.png' } },
    judgement: { by: 'judge', reason: 'Visible failure', at: 'now' },
    occurrences: 1,
    firstSeenAt: 'now',
    lastSeenAt: 'now',
  };
  await workspace.saveIssue(issue);
  await writeFile(join(root, 'shot.png'), 'png');
  const config = parseConfig({
    version: 1,
    app: { connect: { url: 'http://localhost' } },
    agents: { github: { enabled: true, repo: 'o/r' } },
  });
  return { root, workspace, issue, config };
}
const runtime: Runtime = {
  label: 'fake',
  async run(task) {
    const view = task.tools.find((tool) => tool.name === 'view_item')!;
    const publish = task.tools.find((tool) => tool.name === 'publish')!;
    await view.run({ issue_id: 'iss_1' });
    const response = await publish.run({
      issue_id: 'iss_1',
      type: 'fix',
      scope: 'app',
      title: 'Fix the screen',
      summary: 'The screen broke. This change fixes it.',
    });
    expect(response.isError).toBe(false);
    return { stop: 'done', steps: 2, costUsd: 0 };
  },
};
const createRuntime = () => runtime;
function fakeGh(calls: string[][]): Gh {
  return async (args) => {
    calls.push(args);
    if (args[0] === 'repo') return 'main';
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/8';
    if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/4';
    if (args[0] === 'search') return '[]';
    return '{}';
  };
}

describe('runPublisher', () => {
  it('does not publish a rejected fix or its issue', async () => {
    const f = await fixture();
    await f.workspace.saveFix({
      version: 1,
      id: 'fix_1',
      issueId: f.issue.id,
      status: 'rejected',
      runtime: 'fake',
      repo: '',
      branch: '',
      worktree: '',
      startedAt: 'now',
    });
    const calls: string[][] = [];
    expect(await runPublisher(f.root, f.config, { gh: fakeGh(calls), createRuntime })).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('publishes a verified fix once as a PR', async () => {
    const f = await fixture();
    const source = join(f.root, 'source');
    await mkdir(source);
    const fix: FixProposal = {
      version: 1,
      id: 'fix_1',
      issueId: f.issue.id,
      status: 'verified',
      runtime: 'fake',
      repo: source,
      worktree: source,
      branch: 'fix',
      startedAt: 'now',
      summary: 'Fixed',
    };
    await f.workspace.saveFix(fix);
    // A fake Git directory lets git status and push run without touching GitHub.
    const { execFileSync } = await import('node:child_process');
    const remote = join(f.root, 'remote.git');
    execFileSync('git', ['init', '--bare', remote]);
    execFileSync('git', ['init', source]);
    execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', source, 'config', 'commit.gpgsign', 'false']);
    await writeFile(join(source, 'app.txt'), 'app');
    execFileSync('git', ['-C', source, 'add', 'app.txt']);
    execFileSync('git', ['-C', source, 'commit', '-m', 'initial']);
    execFileSync('git', ['-C', source, 'remote', 'add', 'origin', remote]);
    execFileSync('git', ['-C', source, 'checkout', '-b', 'fix']);
    await writeFile(join(source, 'app.txt'), 'fixed');
    execFileSync('git', ['-C', source, 'add', 'app.txt']);
    execFileSync('git', ['-C', source, 'commit', '-m', 'fix: screen']);
    fix.commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await f.workspace.saveFix(fix);
    const calls: string[][] = [];
    expect(await runPublisher(f.root, f.config, { gh: fakeGh(calls), createRuntime })).toMatchObject([
      { kind: 'pr', issueId: 'iss_1', url: 'https://github.com/o/r/pull/4' },
    ]);
    expect((await f.workspace.readFix(fix.id))?.pr?.number).toBe(4);
    const create = calls.find((args) => args[0] === 'pr' && args[1] === 'create')!;
    expect(create[create.indexOf('--title') + 1]).toBe('fix(app): fix the screen');
    const count = calls.length;
    expect(await runPublisher(f.root, f.config, { gh: fakeGh(calls), createRuntime })).toEqual([]);
    expect(calls.length).toBe(count);
  });
  it('does not publish a fix that the retest did not verify', async () => {
    for (const outcome of ['unclear', 'not-fixed'] as const) {
      const f = await fixture();
      await f.workspace.saveFix({
        version: 1,
        id: 'fix_1',
        issueId: f.issue.id,
        status: 'proposed',
        runtime: 'fake',
        repo: '',
        branch: 'fix',
        worktree: '',
        startedAt: 'now',
        retests: [{ attempt: 1, outcome, reason: 'The explorer did not reach the screen.', at: 'now' }],
      });
      const calls: string[][] = [];
      expect(await runPublisher(f.root, f.config, { gh: fakeGh(calls), createRuntime })).toEqual([]);
      expect(calls).toEqual([]);
    }
  });
  it('publishes a major issue after a declined fix', async () => {
    const f = await fixture();
    await f.workspace.saveFix({
      version: 1,
      id: 'fix_1',
      issueId: f.issue.id,
      status: 'declined',
      runtime: 'fake',
      repo: '',
      branch: '',
      worktree: '',
      startedAt: 'now',
      summary: 'No change',
    });
    const calls: string[][] = [];
    expect(await runPublisher(f.root, f.config, { gh: fakeGh(calls), createRuntime })).toMatchObject([
      { kind: 'issue', url: 'https://github.com/o/r/issues/8' },
    ]);
    expect((await f.workspace.readIssue(f.issue.id))?.github?.number).toBe(8);
  });
  it('ignores minor and dismissed issues', async () => {
    for (const [severity, status] of [
      ['minor', 'new'],
      ['major', 'dismissed'],
    ] as const) {
      const f = await fixture(severity, status);
      expect(await runPublisher(f.root, f.config, { gh: fakeGh([]), createRuntime })).toEqual([]);
      expect(await f.workspace.listSessions()).toEqual([]);
    }
  });
  it('records unavailable gh without publishing', async () => {
    const f = await fixture();
    const gh: Gh = async (args) => {
      if (args[0] === 'repo') throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 401: Bad credentials' });
      return 'gh version 2';
    };
    expect(await runPublisher(f.root, f.config, { gh, createRuntime })).toEqual([]);
    expect((await f.workspace.listSessions())[0]?.summary).toContain('HTTP 401: Bad credentials');
    expect((await f.workspace.readIssue(f.issue.id))?.github).toBeUndefined();
  });
  it('publishes an API issue with its exchange as an http block, and uploads no file', async () => {
    const f = await fixture();
    await f.workspace.saveIssue({
      ...f.issue,
      evidence: {
        capture: {
          kind: 'http',
          exchange: {
            request: { method: 'GET', path: '/items/0', headers: {} },
            response: {
              status: 500,
              headers: { 'content-type': 'application/json' },
              contentType: 'application/json',
              body: '{"error":"Division by zero."}',
              bytes: 29,
            },
            latencyMs: 4,
            at: 'now',
          },
        },
      },
    });
    let viewed: Awaited<ReturnType<Tool['run']>> | undefined;
    const viewing: Runtime = {
      ...runtime,
      async run(task, emit) {
        viewed = await task.tools.find((tool) => tool.name === 'view_item')!.run({ issue_id: 'iss_1' });
        return runtime.run(task, emit);
      },
    };
    const calls: string[][] = [];
    expect(
      await runPublisher(f.root, f.config, { gh: fakeGh(calls), createRuntime: () => viewing, dryRun: true }),
    ).toMatchObject([{ kind: 'issue' }]);
    expect(viewed?.content.map((part) => part.type)).toEqual(['text', 'text']);
    expect(viewed?.content[1]).toMatchObject({ text: expect.stringContaining('HTTP 500 Internal Server Error') });
    const report = await readFile(join(f.root, '.bugpatrol/runs/publish/iss_1.md'), 'utf8');
    expect(report).toContain('## Request\n\n```http\nGET /items/0\n\nHTTP 500 Internal Server Error (4 ms)');
    expect(report).not.toContain('## Screenshots');
    expect(calls).toEqual([]);
  });
  it('reviews and drafts an issue stored before evidence.capture existed', async () => {
    const f = await fixture();
    const { capture: _capture, ...evidence } = f.issue.evidence;
    await f.workspace.saveIssue({
      ...f.issue,
      evidence: { ...evidence, screenshot: '.bughunters/runs/shot.png' } as unknown as Issue['evidence'],
    });
    await mkdir(join(f.root, '.bugpatrol', 'runs'), { recursive: true });
    await writeFile(join(f.root, '.bugpatrol', 'runs', 'shot.png'), 'png');
    let viewed: Awaited<ReturnType<Tool['run']>> | undefined;
    const reviewing: Runtime = {
      label: 'fake',
      async run(task) {
        viewed = await task.tools.find((tool) => tool.name === 'view_item')!.run({ issue_id: 'iss_1' });
        await task.tools
          .find((tool) => tool.name === 'publish')!
          .run({ issue_id: 'iss_1', title: 'Broken screen', summary: 'The screen broke.' });
        return { stop: 'done', steps: 2, costUsd: 0 };
      },
    };
    const [outcome] = await runPublisher(f.root, f.config, { createRuntime: () => reviewing, dryRun: true });
    expect(viewed?.content.map((part) => part.type)).toEqual(['text', 'image']);
    expect(await readFile(outcome!.url!, 'utf8')).toContain('.bugpatrol/runs/shot.png');
  });
  it('reviews and drafts a verified fix whose retests were stored before the rename', async () => {
    const f = await fixture('major', 'fix-proposed');
    const { capture: _capture, ...evidence } = f.issue.evidence;
    await f.workspace.saveIssue({
      ...f.issue,
      evidence: { ...evidence, screenshot: '.bughunters/runs/issue.png' } as unknown as Issue['evidence'],
    });
    await f.workspace.saveFix({
      version: 1,
      id: 'fix_1',
      issueId: 'iss_1',
      status: 'verified',
      runtime: 'fake',
      repo: '',
      worktree: '',
      branch: 'fix',
      startedAt: 'now',
      retests: [
        {
          attempt: 1,
          outcome: 'fixed',
          reason: 'The screen works after the fix.',
          before: '.bughunters/runs/before.png',
          after: '.bughunters/runs/after.png',
          at: 'now',
        },
      ],
    });
    await mkdir(join(f.root, '.bugpatrol', 'runs'), { recursive: true });
    for (const name of ['issue', 'before', 'after']) {
      await writeFile(join(f.root, '.bugpatrol', 'runs', `${name}.png`), name);
    }
    let viewed: Awaited<ReturnType<Tool['run']>> | undefined;
    const reviewing: Runtime = {
      label: 'fake',
      async run(task) {
        viewed = await task.tools.find((tool) => tool.name === 'view_item')!.run({ issue_id: 'iss_1' });
        await task.tools
          .find((tool) => tool.name === 'publish')!
          .run({ issue_id: 'iss_1', type: 'fix', title: 'repair the screen', summary: 'The screen now works.' });
        return { stop: 'done', steps: 2, costUsd: 0 };
      },
    };
    const [outcome] = await runPublisher(f.root, f.config, { createRuntime: () => reviewing, dryRun: true });
    expect(viewed?.content.map((part) => part.type)).toEqual(['text', 'image', 'image']);
    const report = await readFile(outcome!.url!, 'utf8');
    expect(report).toContain('.bugpatrol/runs/before.png');
    expect(report).toContain('.bugpatrol/runs/after.png');
    expect(report).not.toContain('.bughunters/');
  });
  it('writes a dry-run report without any gh calls', async () => {
    const f = await fixture();
    const calls: string[][] = [];
    expect(await runPublisher(f.root, f.config, { gh: fakeGh(calls), createRuntime, dryRun: true })).toMatchObject([
      { kind: 'issue' },
    ]);
    expect(calls).toEqual([]);
    expect(await readFile(join(f.root, '.bugpatrol/runs/publish/iss_1.md'), 'utf8')).toContain('## What happened');
    expect((await f.workspace.readIssue(f.issue.id))?.github).toBeUndefined();
  });
});
