import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type BugpatrolConfig, ConfigError, type ExternalFixSource, type FixProposal, paths } from '@bugpatrol/core';
import { Workspace } from '../workspace.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

type Gh = (args: string[], opts: { cwd: string }) => Promise<string>;
const defaultGh: Gh = async (args, opts) => (await exec('gh', args, { cwd: opts.cwd })).stdout;

export type ExternalFixTarget =
  | { kind: 'worktree'; path: string }
  | { kind: 'branch'; ref: string }
  | { kind: 'pr'; number: number; allowFork?: boolean };

/** The commit of `ref`, from the local branches first, then from origin. */
async function resolveRef(repo: string, ref: string): Promise<string> {
  try {
    return await git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    /* Not local: it may only be on the remote. */
  }
  try {
    await git(repo, 'fetch', '-q', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`);
    return await git(repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}^{commit}`);
  } catch {
    throw new ConfigError(`No branch or commit ${ref} in ${repo}, locally or on origin.`);
  }
}

/** A detached checkout of `commit` that Bugpatrol owns, so `worktrees clean` may remove it later. */
async function checkout(root: string, repo: string, issueId: string, commit: string): Promise<string> {
  const worktree = join(paths.worktrees(root), `${issueId}-external`);
  await mkdir(paths.worktrees(root), { recursive: true });
  try {
    await git(repo, 'worktree', 'remove', '--force', worktree);
  } catch {
    /* No earlier checkout of this issue. */
  }
  await rm(worktree, { recursive: true, force: true });
  await git(repo, 'worktree', 'prune');
  await git(repo, 'worktree', 'add', '-q', '--detach', worktree, commit);
  return worktree;
}

/**
 * Record a fix that someone else wrote (Claude Code, a teammate, any PR or
 * branch) as the fix of an issue, so `retestFix` can judge it like a fixer
 * proposal. The fixer, publish, and CI steps leave an external fix alone:
 * Bugpatrol never rewrites, pushes to, or opens a PR for code it did not write.
 */
export async function attachExternalFix(
  root: string,
  config: BugpatrolConfig,
  issueId: string,
  target: ExternalFixTarget,
  opts: { summary?: string; gh?: Gh } = {},
): Promise<FixProposal> {
  const workspace = new Workspace(root);
  const issue = await workspace.readIssue(issueId);
  if (!issue) throw new ConfigError(`No issue ${issueId}`);
  const existing = issue.fixId ? await workspace.readFix(issue.fixId) : undefined;
  if (existing && !existing.external)
    throw new ConfigError(
      `${issueId} already has a Bugpatrol fix (${existing.status}). Run \`bugpatrol retest --issue ${issueId}\` to retest it.`,
    );
  const repo = resolve(root, config.app.source);
  let source: ExternalFixSource;
  let worktree: string;
  let commit: string;
  let branch = '';
  let summary = opts.summary;
  let pr: FixProposal['pr'];
  switch (target.kind) {
    case 'worktree': {
      worktree = resolve(target.path);
      try {
        commit = await git(worktree, 'rev-parse', 'HEAD');
      } catch {
        throw new ConfigError(`${worktree} is not a git checkout.`);
      }
      branch = await git(worktree, 'branch', '--show-current');
      source = { kind: 'worktree', ref: worktree };
      break;
    }
    case 'branch': {
      commit = await resolveRef(repo, target.ref);
      branch = target.ref;
      worktree = await checkout(root, repo, issueId, commit);
      source = { kind: 'branch', ref: target.ref };
      break;
    }
    case 'pr': {
      const gh = opts.gh ?? defaultGh;
      const view = JSON.parse(
        await gh(
          [
            'pr',
            'view',
            String(target.number),
            '--json',
            'number,title,url,headRefName,headRefOid,isDraft,state,isCrossRepository',
          ],
          { cwd: repo },
        ),
      ) as {
        number: number;
        title: string;
        url: string;
        headRefName: string;
        headRefOid: string;
        isDraft: boolean;
        state: 'OPEN' | 'MERGED' | 'CLOSED';
        isCrossRepository: boolean;
      };
      if (view.isCrossRepository && !target.allowFork)
        throw new ConfigError(
          `PR #${view.number} comes from a fork. A retest runs its code on this machine, with the secrets of the app. ` +
            'Read the diff first. If you trust it, run the retest again with --allow-fork.',
        );
      await git(repo, 'fetch', '-q', 'origin', `+refs/pull/${view.number}/head:refs/bugpatrol/pr-${view.number}`);
      commit = view.headRefOid;
      branch = view.headRefName;
      worktree = await checkout(root, repo, issueId, commit);
      summary ??= view.title;
      pr = {
        number: view.number,
        url: view.url,
        draft: view.isDraft,
        state: view.state.toLowerCase() as NonNullable<FixProposal['pr']>['state'],
        checkedAt: new Date().toISOString(),
      };
      source = { kind: 'pr', ref: view.url };
      break;
    }
  }
  summary ??= await git(repo, 'log', '-1', '--format=%s', commit);
  const fix: FixProposal = {
    ...existing,
    version: 1,
    id: existing?.id ?? `fix_${issueId}`,
    issueId,
    status: 'retesting',
    runtime: 'external',
    external: source,
    repo,
    branch,
    worktree,
    worktreeRemovedAt: undefined,
    commit,
    summary,
    startedAt: new Date().toISOString(),
    pr,
  };
  await workspace.saveFix(fix);
  if (issue.fixId !== fix.id) await workspace.saveIssue({ ...issue, fixId: fix.id });
  return fix;
}
