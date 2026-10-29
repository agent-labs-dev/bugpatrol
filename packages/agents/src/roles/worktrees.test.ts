import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixProposal, type Issue, parseConfig } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentSession } from '../session.js';
import type { Runtime } from '../types.js';
import { Vars } from '../vars.js';
import { Workspace } from '../workspace.js';
import { runFixer } from './fixer.js';
import { cleanWorktrees } from './worktrees.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

async function fixture(status: FixProposal['status'] = 'declined') {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-worktrees-'));
  roots.push(root);
  const repo = join(root, 'source');
  const remote = join(root, 'remote.git');
  const worktree = join(root, '.bugpatrol', 'runs', 'worktrees', 'iss_1');
  const branch = 'bugpatrol/fix-iss_1';
  await mkdir(repo);
  execFileSync('git', ['init', '--bare', '-q', remote], { stdio: 'pipe' });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'app.txt'), 'original\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  await mkdir(join(root, '.bugpatrol', 'runs', 'worktrees'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'HEAD');
  const workspace = new Workspace(root);
  const issue: Issue = {
    version: 1,
    id: 'iss_1',
    fingerprint: 'fp',
    title: 'Broken screen',
    body: 'Broken',
    severity: 'major',
    status: 'filed',
    candidateIds: [],
    evidence: { capture: { kind: 'image', screenshot: 'shot.png' } },
    judgement: { by: 'judge', reason: 'Broken', at: 'now' },
    occurrences: 1,
    firstSeenAt: 'now',
    lastSeenAt: 'now',
    fixId: 'fix_iss_1',
  };
  const fix: FixProposal = {
    version: 1,
    id: 'fix_iss_1',
    issueId: issue.id,
    status,
    runtime: 'fake',
    repo,
    branch,
    worktree,
    startedAt: 'now',
  };
  await workspace.saveIssue(issue);
  await workspace.saveFix(fix);
  const config = parseConfig({
    version: 1,
    app: { source: 'source', connect: { url: 'http://localhost' } },
    agents: { fixer: { enabled: true, use: { runtime: 'cli', command: 'fake' } } },
  });
  return { root, repo, remote, worktree, branch, workspace, issue, fix, config };
}

describe('cleanWorktrees', () => {
  it('removes a merged PR worktree and its merged local branch', async () => {
    const f = await fixture('verified');
    await writeFile(join(f.worktree, 'app.txt'), 'fixed\n');
    git(f.worktree, 'add', '.');
    git(f.worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fix');
    git(f.repo, 'merge', '--ff-only', f.branch);
    await f.workspace.saveFix({
      ...f.fix,
      pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: false, state: 'merged' },
    });
    expect((await cleanWorktrees(f.root, f.config)).removed).toEqual(['fix_iss_1']);
    expect(existsSync(f.worktree)).toBe(false);
    expect((await f.workspace.readFix(f.fix.id))?.worktreeRemovedAt).toBeTruthy();
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('keeps a worktree with uncommitted changes', async () => {
    const f = await fixture('verified');
    await f.workspace.saveFix({
      ...f.fix,
      pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: false, state: 'merged' },
    });
    await writeFile(join(f.worktree, 'app.txt'), 'local change\n');
    expect(await cleanWorktrees(f.root, f.config)).toEqual({
      removed: [],
      kept: [{ id: f.fix.id, reason: 'uncommitted changes' }],
    });
    expect(existsSync(f.worktree)).toBe(true);
  });

  it('deletes an unmerged local branch only when the remote has its commit', async () => {
    const f = await fixture('verified');
    await writeFile(join(f.worktree, 'app.txt'), 'fixed\n');
    git(f.worktree, 'add', '.');
    git(f.worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fix');
    git(f.worktree, 'push', '-q', '-u', 'origin', f.branch);
    git(f.repo, 'update-ref', '-d', `refs/remotes/origin/${f.branch}`);
    git(f.repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    await f.workspace.saveFix({
      ...f.fix,
      pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: false, state: 'closed' },
    });
    expect((await cleanWorktrees(f.root, f.config)).removed).toEqual([f.fix.id]);
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('keeps unpublished commits even when a stale tracking ref matches', async () => {
    const f = await fixture('verified');
    await writeFile(join(f.worktree, 'app.txt'), 'unpublished\n');
    git(f.worktree, 'add', '.');
    git(f.worktree, 'commit', '-qm', 'local fix');
    git(f.repo, 'update-ref', `refs/remotes/origin/${f.branch}`, git(f.worktree, 'rev-parse', 'HEAD'));
    await f.workspace.saveFix({
      ...f.fix,
      pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: false, state: 'closed' },
    });
    await cleanWorktrees(f.root, f.config);
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe(f.branch);
  });

  it('removes an unchanged declined fix and its empty branch', async () => {
    const f = await fixture();
    expect((await cleanWorktrees(f.root, f.config)).removed).toEqual([f.fix.id]);
    expect(existsSync(f.worktree)).toBe(false);
    expect((await f.workspace.readFix(f.fix.id))?.worktreeRemovedAt).toBeTruthy();
    // The branch had no commit of its own, so deleting it loses nothing.
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('removes a fix for a closed issue and records an already missing worktree', async () => {
    const f = await fixture('verified');
    await f.workspace.saveIssue({ ...f.issue, status: 'fixed' });
    expect((await cleanWorktrees(f.root, f.config)).removed).toEqual([f.fix.id]);
    const fix = (await f.workspace.readFix(f.fix.id))!;
    await f.workspace.saveFix({ ...fix, worktreeRemovedAt: undefined });
    expect((await cleanWorktrees(f.root, f.config)).removed).toEqual([f.fix.id]);
    expect((await f.workspace.readFix(f.fix.id))?.worktreeRemovedAt).toBeTruthy();
  });

  it('keeps an unpublished commit on a failed fix', async () => {
    const f = await fixture('failed');
    await writeFile(join(f.worktree, 'app.txt'), 'attempted fix\n');
    git(f.worktree, 'add', '.');
    git(f.worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'attempt');
    expect(await cleanWorktrees(f.root, f.config)).toEqual({
      removed: [],
      kept: [{ id: f.fix.id, reason: 'local commits' }],
    });
    expect(existsSync(f.worktree)).toBe(true);
  });

  it('creates a numbered branch when a later refix finds the old branch', async () => {
    const f = await fixture('failed');
    await cleanWorktrees(f.root, f.config);
    // The old branch still exists, e.g. it holds a rejected change.
    git(f.repo, 'branch', f.branch);
    const record = await f.workspace.startSession('fixer');
    const session = new AgentSession(f.root, f.config, new Vars(), record.id, 'fixer');
    const runtime: Runtime = {
      label: 'fake',
      async run() {
        return { stop: 'done', steps: 0, costUsd: 0, summary: 'No change needed' };
      },
    };
    const [proposal] = await runFixer(session, runtime, { issueIds: [f.issue.id] });
    expect(proposal?.branch).toBe('bugpatrol/fix-iss_1-2');
    expect(proposal?.worktree).toBe(f.worktree);
    expect(proposal?.worktreeRemovedAt).toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(git(f.repo, 'rev-parse', 'HEAD'));
  });
});
