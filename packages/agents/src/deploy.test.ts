import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startFixtureApi } from '@bugpatrol/api-fixture';
import { type FixProposal, type Issue, parseConfig, type RetestOutcome } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import { deployedCommit } from './deploy.js';
import { runPatrol } from './patrol.js';
import { recheckMerged } from './roles/retest.js';
import { FakeDriver } from './testing/fake-driver.js';
import type { Runtime } from './types.js';
import { Workspace } from './workspace.js';

const exec = promisify(execFile);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-deploy-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const fleet = { path: '/version/fleet', pointer: '/result/*/commit' };

describe('deployedCommit', () => {
  it('mixed fleet is pending', async () => {
    const api = await startFixtureApi({ commit: 'aaa' });
    cleanup.push(() => api.close());
    expect(await deployedCommit(api.url, fleet)).toEqual({ commit: 'aaa' });
    api.setFleet(['aaa', 'bbb', 'aaa']);
    expect(await deployedCommit(api.url, fleet)).toEqual({ pending: expect.stringContaining('2 commits') });
    api.setFleet(['bbb', 'bbb']);
    expect(await deployedCommit(api.url, fleet)).toEqual({ commit: 'bbb' });
    expect(await deployedCommit(api.url, { path: '/version', pointer: '/result/commit' })).toEqual({ commit: 'aaa' });
  });

  it('null commit is pending', async () => {
    const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
    const nulls = answer({ result: [{ commit: 'aaa' }, { commit: null }] });
    expect(await deployedCommit('http://x', fleet, nulls)).toEqual({ pending: expect.stringContaining('no commit') });
    expect(await deployedCommit('http://x', fleet, answer({ result: [] }))).toMatchObject({
      pending: expect.any(String),
    });
    const down = (async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    expect(await deployedCommit('http://x', fleet, down)).toEqual({ pending: expect.stringContaining('refused') });
  });
});

describe('patrol on an external backend', () => {
  it('no new cycle until /version changes', async () => {
    const root = await tempDir();
    const api = await startFixtureApi({ commit: 'aaa' });
    cleanup.push(() => api.close());
    const config = parseConfig({
      version: 1,
      app: {
        platform: 'api',
        connect: { url: api.url, version: { path: '/version', pointer: '/result/commit' } },
      },
      agents: { memory: { enabled: false }, judge: { enabled: false }, patrol: { pull: false } },
    });
    let runs = 0;
    const once = () =>
      runPatrol({
        root,
        config,
        once: true,
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run() {
            runs++;
            return { stop: 'done', steps: 0, costUsd: 0, summary: 'Done' };
          },
        }),
      });
    await once();
    await once();
    expect(runs).toBe(1);
    api.setFleet(['bbb']);
    await once();
    expect(runs).toBe(1);
    api.setCommit('bbb');
    await once();
    expect(runs).toBe(2);
    expect(await new Workspace(root).readDeploy()).toMatchObject({ commit: 'bbb' });
  });
});

/**
 * A source repo whose fix branch was squash merged, a fix with a PR, and a
 * fake `gh` that reports the PR as merged with the squash commit.
 */
async function mergedFix(version?: { path: string; pointer: string }) {
  const root = await tempDir();
  const source = join(root, 'source');
  await mkdir(source);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: source })).stdout.trim();
  await git('init', '-q');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Bugpatrol Test');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.hooksPath', '/dev/null');
  await writeFile(join(source, 'app.txt'), 'broken\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'initial');
  const old = await git('rev-parse', 'HEAD');
  await git('checkout', '-q', '-b', 'fix');
  await writeFile(join(source, 'app.txt'), 'fixed\n');
  await git('commit', '-q', '-am', 'fix');
  const fixCommit = await git('rev-parse', 'HEAD');
  await git('checkout', '-q', old);
  await git('merge', '-q', '--squash', 'fix');
  await git('commit', '-q', '-m', 'fix (#7)');
  const squash = await git('rev-parse', 'HEAD');

  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'gh'),
    `#!/bin/sh\necho '${JSON.stringify({ state: 'MERGED', mergeCommit: { oid: squash } })}'\n`,
  );
  await chmod(join(bin, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  cleanup.push(() => {
    process.env.PATH = path;
  });

  const workspace = new Workspace(root);
  await writeFile(join(root, 'reported.png'), '');
  const issue: Issue = {
    version: 1,
    id: 'iss_1',
    fingerprint: 'fp',
    title: 'Items are broken',
    body: 'What happened: broken',
    severity: 'major',
    status: 'fix-proposed',
    candidateIds: [],
    evidence: { capture: { kind: 'image', screenshot: 'reported.png' }, steps: [{ kind: 'open', url: 'fake://home' }] },
    judgement: { by: 'judge', reason: 'visible', at: 'now' },
    occurrences: 1,
    firstSeenAt: 'now',
    lastSeenAt: 'now',
  };
  await workspace.saveIssue(issue);
  const fix: FixProposal = {
    version: 1,
    id: 'fix_iss_1',
    issueId: 'iss_1',
    status: 'opened',
    runtime: 'scripted',
    repo: source,
    worktree: join(root, 'worktree'),
    branch: 'fix',
    commit: fixCommit,
    startedAt: 'now',
    pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: false },
  };
  await workspace.saveFix(fix);
  const config = parseConfig({
    version: 1,
    app: { platform: 'api', source: 'source', connect: { url: 'http://127.0.0.1:9', version } },
    agents: { memory: { enabled: false } },
  });
  const deployAt = (commit: string) => workspace.writeDeploy({ version: 1, commit, checkedAt: 'now' });
  const recheck = (outcome: RetestOutcome) =>
    recheckMerged(root, config, {
      createDriver: () => new FakeDriver({ home: { elements: [] } }),
      createRuntime: () => scripted(outcome),
    });
  return { workspace, old, squash, fixCommit, deployAt, recheck };
}

function scripted(outcome: RetestOutcome): Runtime {
  return {
    label: 'scripted',
    async run(task) {
      if (task.role === 'explorer')
        await task.tools.find((tool) => tool.name === 'capture_after')!.run({ target: 1, note: 'Seen', reached: true });
      if (task.role === 'judge')
        await task.tools.find((tool) => tool.name === 'verdict')!.run({ outcome, reason: outcome });
      return { stop: 'done', steps: 1, costUsd: 0 };
    },
  };
}

describe('merged fix on an external backend', () => {
  it('squash merge commit is found', async () => {
    const f = await mergedFix({ path: '/version', pointer: '/result/commit' });
    await f.deployAt(f.squash);
    expect((await f.recheck('fixed')).closed).toEqual(['iss_1']);
    expect((await f.workspace.readFix('fix_iss_1'))?.mergeCommit).toBe(f.squash);
    expect(await f.workspace.readIssue('iss_1')).toMatchObject({
      status: 'fixed',
      closedBy: { reason: expect.stringContaining('deployed backend') },
    });
  });

  it('a rollback to an older commit waits again', async () => {
    const f = await mergedFix({ path: '/version', pointer: '/result/commit' });
    const state = async () => ({
      status: (await f.workspace.readIssue('iss_1'))?.status,
      retests: (await f.workspace.readFix('fix_iss_1'))?.retests?.length ?? 0,
    });
    // The fix branch commit alone is not the merge: the deploy must contain the squash commit.
    await f.deployAt(f.fixCommit);
    await f.recheck('fixed');
    expect(await state()).toEqual({ status: 'waits-for-deploy', retests: 0 });
    await f.deployAt(f.squash);
    await f.recheck('unclear');
    expect(await state()).toEqual({ status: 'fix-proposed', retests: 1 });
    await f.deployAt(f.old);
    await f.recheck('fixed');
    expect(await state()).toEqual({ status: 'waits-for-deploy', retests: 1 });
  });

  it('no version endpoint never marks failed', async () => {
    const f = await mergedFix();
    await f.recheck('not-fixed');
    await f.recheck('not-fixed');
    const fix = await f.workspace.readFix('fix_iss_1');
    expect(fix?.retests?.map((retest) => retest.outcome)).toEqual(['not-fixed', 'not-fixed']);
    expect(fix?.status).toBe('opened');
    expect((await f.workspace.readIssue('iss_1'))?.status).toBe('waits-for-deploy');
    expect((await f.recheck('fixed')).closed).toEqual(['iss_1']);
    expect((await f.workspace.readIssue('iss_1'))?.status).toBe('fixed');
  });
});
