import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Issue, parseConfig } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from '../workspace.js';
import { attachExternalFix } from './external-fix.js';
import { cleanWorktrees } from './worktrees.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-external-'));
  roots.push(root);
  const repo = join(root, 'source');
  await mkdir(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'app.txt'), 'broken\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'branch', '-M', 'main');
  // The branch that Claude Code left behind, with the fix on it.
  git(repo, 'checkout', '-qb', 'claude/fix-menu');
  await writeFile(join(repo, 'app.txt'), 'fixed\n');
  git(repo, 'commit', '-qam', 'Fix the menu');
  git(repo, 'checkout', '-q', 'main');
  const workspace = new Workspace(root);
  const issue: Issue = {
    version: 1,
    id: 'iss_1',
    fingerprint: 'fp',
    title: 'Broken menu',
    body: 'Broken',
    severity: 'major',
    status: 'filed',
    candidateIds: [],
    evidence: { capture: { kind: 'image', screenshot: 'shot.png' } },
    judgement: { by: 'judge', reason: 'Broken', at: 'now' },
    occurrences: 1,
    firstSeenAt: 'now',
    lastSeenAt: 'now',
  };
  await workspace.saveIssue(issue);
  const config = parseConfig({ version: 1, app: { source: 'source', connect: { url: 'http://localhost' } } });
  return { root, repo, workspace, issue, config };
}

describe('attachExternalFix', () => {
  it('checks out a branch that Bugpatrol did not write and makes it the fix of the issue', async () => {
    const f = await fixture();
    const fix = await attachExternalFix(f.root, f.config, f.issue.id, { kind: 'branch', ref: 'claude/fix-menu' });
    expect(fix).toMatchObject({
      status: 'retesting',
      external: { kind: 'branch', ref: 'claude/fix-menu' },
      branch: 'claude/fix-menu',
      commit: git(f.repo, 'rev-parse', 'claude/fix-menu'),
      summary: 'Fix the menu',
    });
    expect(await readFile(join(fix.worktree, 'app.txt'), 'utf8')).toBe('fixed\n');
    expect((await f.workspace.readIssue(f.issue.id))?.fixId).toBe(fix.id);

    // Cleanup removes Bugpatrol's checkout, and never the author's branch, even once it merged.
    git(f.repo, 'merge', '-q', '--ff-only', 'claude/fix-menu');
    await f.workspace.saveFix({ ...fix, status: 'verified' });
    await f.workspace.saveIssue({ ...f.issue, fixId: fix.id, status: 'fixed' });
    expect((await cleanWorktrees(f.root, f.config)).removed).toEqual([fix.id]);
    expect(existsSync(fix.worktree)).toBe(false);
    expect(git(f.repo, 'branch', '--list', 'claude/fix-menu')).not.toBe('');
  });

  it('uses a checkout on this machine as it is', async () => {
    const f = await fixture();
    const path = join(f.root, 'claude-worktree');
    git(f.repo, 'worktree', 'add', '-q', path, 'claude/fix-menu');
    const fix = await attachExternalFix(f.root, f.config, f.issue.id, { kind: 'worktree', path }, { summary: 'Mine' });
    expect(fix).toMatchObject({ worktree: path, branch: 'claude/fix-menu', summary: 'Mine' });
  });

  it('leaves a fix of the Bugpatrol fixer alone', async () => {
    const f = await fixture();
    await f.workspace.saveFix({
      version: 1,
      id: 'fix_iss_1',
      issueId: f.issue.id,
      status: 'proposed',
      runtime: 'cli',
      repo: f.repo,
      branch: 'bugpatrol/fix-iss_1',
      worktree: join(f.root, 'wt'),
      startedAt: 'now',
    });
    await f.workspace.saveIssue({ ...f.issue, fixId: 'fix_iss_1' });
    await expect(
      attachExternalFix(f.root, f.config, f.issue.id, { kind: 'branch', ref: 'claude/fix-menu' }),
    ).rejects.toThrow(/already has a Bugpatrol fix/);
  });

  it('names a branch that does not exist', async () => {
    const f = await fixture();
    await expect(attachExternalFix(f.root, f.config, f.issue.id, { kind: 'branch', ref: 'nope' })).rejects.toThrow(
      /No branch or commit nope/,
    );
  });
});
