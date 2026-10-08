import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type BugpatrolConfig, type FixProposal, type Issue, judgedRetests, type Routine } from '@bugpatrol/core';
import { reproRoutineId } from './report.js';
import { commitFix } from './roles/fixer.js';
import { dismissedFingerprints, Workspace } from './workspace.js';

export type Gh = (args: string[], opts?: { cwd?: string; input?: string }) => Promise<string>;

export const defaultGh: Gh = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile('gh', args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr, stdout }));
      else resolve(stdout.trim());
    });
    child.stdin?.end(opts?.input);
  });

const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const json = (value: unknown) => JSON.stringify(value);
const errorText = (error: unknown) => `${String(error)} ${(error as { stderr?: string }).stderr ?? ''}`;
const missing = (error: unknown) => /404|not found/i.test(errorText(error));

export async function ghReady(gh: Gh = defaultGh): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await gh(['--version']);
  } catch {
    return {
      ok: false,
      reason: 'GitHub publish skipped: the gh CLI is not installed. Install it from https://cli.github.com',
    };
  }
  try {
    await gh(['auth', 'status']);
  } catch {
    return { ok: false, reason: 'GitHub publish skipped: gh is not logged in. Run `gh auth login`.' };
  }
  return { ok: true };
}

export async function resolveRepo(
  gh: Gh,
  config: BugpatrolConfig,
  source: string,
): Promise<{ repo: string; defaultBranch: string }> {
  const repo =
    config.agents.github.repo ??
    (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: source }));
  const defaultBranch = await gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], {
    cwd: source,
  });
  return { repo, defaultBranch };
}

/** The label of the PRs and issues from before the rename to Bugpatrol. */
const LEGACY_LABEL = 'bughunters';

/**
 * The Bugpatrol PRs and issues on GitHub, from every machine that runs a
 * patrol on the repo: each one open, and each PR merged or closed in the last
 * 14 days. The publish judge reads them to skip a duplicate.
 */
export async function listFiled(gh: Gh, repo: string, config: BugpatrolConfig): Promise<string[]> {
  const labels = [...new Set([config.agents.github.labels[0]!, LEGACY_LABEL])];
  const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
  type Pr = {
    number: number;
    title: string;
    state: string;
    mergedAt?: string;
    closedAt?: string;
    files?: { path: string }[];
  };
  type GhIssue = { number: number; title: string };
  const [prs, issues] = await Promise.all(
    (['pr', 'issue'] as const).map(async (kind) =>
      (
        await Promise.all(
          labels.map((label) =>
            gh([
              kind,
              'list',
              '--repo',
              repo,
              '--label',
              label,
              '--state',
              kind === 'pr' ? 'all' : 'open',
              '--limit',
              '100',
              '--json',
              kind === 'pr' ? 'number,title,state,mergedAt,closedAt,files' : 'number,title',
            ]),
          ),
        )
      ).flatMap((out) => JSON.parse(out) as unknown[]),
    ),
  );
  const lines = new Map<string, string>();
  for (const pr of prs as Pr[]) {
    const at = pr.mergedAt ?? pr.closedAt;
    if (pr.state !== 'OPEN' && (!at || Date.parse(at) < since)) continue;
    const files = (pr.files ?? []).map((file) => file.path).slice(0, 10);
    lines.set(
      `pr${pr.number}`,
      `- PR #${pr.number} [${pr.state.toLowerCase()}]: ${pr.title}${files.length ? ` (files: ${files.join(', ')})` : ''}`,
    );
  }
  for (const issue of issues as GhIssue[])
    lines.set(`issue${issue.number}`, `- issue #${issue.number} [open]: ${issue.title}`);
  return [...lines.values()];
}

export async function syncGitHub(
  root: string,
  config: BugpatrolConfig,
  deps: { gh?: Gh; onLog?: (message: string) => void } = {},
): Promise<{ changed: string[] }> {
  const changed = new Set<string>();
  if (!config.agents.github.enabled) return { changed: [] };
  const gh = deps.gh ?? defaultGh;
  const ready = await ghReady(gh);
  if (!ready.ok) {
    deps.onLog?.(ready.reason);
    return { changed: [] };
  }
  const workspace = new Workspace(root);
  const { repo } = await resolveRepo(gh, config, resolve(root, config.app.source));
  // The PRs and issues from before the rename to Bugpatrol have the old label.
  const labels = [...new Set([config.agents.github.labels[0]!, LEGACY_LABEL])];
  const list = async (kind: 'pr' | 'issue', fields: string) =>
    (
      await Promise.all(
        labels.map((label) =>
          gh([kind, 'list', '--repo', repo, '--label', label, '--state', 'all', '--limit', '300', '--json', fields]),
        ),
      )
    ).flatMap((out) => JSON.parse(out) as unknown[]);
  const [prs, githubIssues] = await Promise.all([
    list('pr', 'number,url,state,mergedAt,closedAt'),
    list('issue', 'number,url,state,stateReason,closedAt'),
  ]);
  type Pr = { number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergedAt?: string; closedAt?: string };
  type GhIssue = {
    number: number;
    url: string;
    state: 'OPEN' | 'CLOSED';
    stateReason?: 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | null;
    closedAt?: string;
  };
  const byPr = new Map((prs as Pr[]).map((pr) => [pr.number, pr]));
  const byIssue = new Map((githubIssues as GhIssue[]).map((issue) => [issue.number, issue]));
  const now = new Date().toISOString();
  const stale = (checkedAt?: string) => !checkedAt || Date.now() - Date.parse(checkedAt) >= 3_600_000;
  const issues = new Map((await workspace.listIssues()).map((issue) => [issue.id, issue]));
  for (const fix of await workspace.listFixes()) {
    const pr = fix.pr && byPr.get(fix.pr.number);
    if (!fix.pr || !pr) continue;
    const previousState = fix.pr.state;
    const state = pr.state.toLowerCase() as NonNullable<FixProposal['pr']>['state'];
    const transition = previousState !== state;
    const save = transition || stale(fix.pr.checkedAt);
    fix.pr.state = state;
    fix.pr.stateAt = state === 'merged' ? pr.mergedAt : state === 'closed' ? pr.closedAt : undefined;
    fix.pr.checkedAt = now;
    if (transition) {
      changed.add(fix.id);
      const issue = issues.get(fix.issueId);
      if (state === 'closed') {
        fix.status = 'rejected';
        if (issue) {
          issue.fixRejected = { pr: pr.number, url: pr.url, at: fix.pr.stateAt ?? now };
          if (issue.status === 'fix-proposed') issue.status = 'filed';
          await workspace.saveIssue(issue);
          changed.add(issue.id);
          const lesson = `The team closed PR #${pr.number} (${issue.title}) without a merge: do not propose that change again.`;
          await workspace.upsertLessons(
            ['judge', 'fixer'].map((role) => ({
              role: role as 'judge' | 'fixer',
              source: 'rejected-pr' as const,
              scope: issue.screenId,
              text: lesson,
            })),
          );
          const record = await workspace.startSession('judge');
          await workspace.appendEvent(record.id, {
            sessionId: record.id,
            role: 'system',
            kind: 'issue',
            summary: `The team rejected PR #${pr.number}: ${issue.title}`,
          });
          await workspace.endSession(record.id, { summary: `Rejected PR #${pr.number}` });
        }
      } else if (state === 'open' && previousState === 'closed' && issue?.fixRejected) {
        fix.status = judgedRetests(fix.retests).at(-1)?.outcome === 'fixed' ? 'verified' : 'proposed';
        issue.fixRejected = undefined;
        await workspace.saveIssue(issue);
        changed.add(issue.id);
      }
    }
    if (save) await workspace.saveFix(fix);
  }
  for (const issue of issues.values()) {
    const remote = issue.github && byIssue.get(issue.github.number);
    if (!issue.github || !remote) continue;
    const previousState = issue.github.state;
    const state = remote.state.toLowerCase() as NonNullable<Issue['github']>['state'];
    const stateReason = remote.stateReason?.toLowerCase() as NonNullable<Issue['github']>['stateReason'] | undefined;
    const transition = issue.github.state !== state;
    const save = transition || stale(issue.github.checkedAt);
    issue.github.state = state;
    issue.github.stateReason = stateReason ?? null;
    issue.github.stateAt = state === 'closed' ? remote.closedAt : undefined;
    issue.github.checkedAt = now;
    if (transition) {
      changed.add(issue.id);
      if (state === 'closed' && stateReason === 'not_planned') {
        const reason = 'Closed on GitHub as not planned.';
        const at = remote.closedAt ?? now;
        issue.status = 'dismissed';
        issue.closedBy = { by: 'GitHub', reason, at };
        await workspace.recordTriage(await dismissedFingerprints(workspace, issue, reason, at));
        await workspace.upsertLessons([
          {
            role: 'judge',
            source: 'human',
            scope: issue.screenId,
            text: `Not a bug: ${issue.title} — ${reason}`.slice(0, 200),
          },
        ]);
      } else if (state === 'closed' && stateReason === 'completed') {
        issue.status = 'fixed';
        issue.closedBy = { by: 'GitHub', reason: 'Closed on GitHub as completed.', at: remote.closedAt ?? now };
      } else if (state === 'open' && previousState === 'closed') {
        issue.status = 'filed';
        issue.closedBy = undefined;
      }
    }
    if (save) await workspace.saveIssue(issue);
  }
  return { changed: [...changed] };
}

export async function ensureAssetsBranch(gh: Gh, repo: string, branch: string): Promise<void> {
  try {
    await gh(['api', `repos/${repo}/git/ref/heads/${branch}`]);
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const blob = JSON.parse(
    await gh(['api', '-X', 'POST', `repos/${repo}/git/blobs`, '--input', '-'], {
      input: json({ content: 'Images for Bugpatrol reports. Not code; do not merge.', encoding: 'utf-8' }),
    }),
  ) as { sha: string };
  const tree = JSON.parse(
    await gh(['api', '-X', 'POST', `repos/${repo}/git/trees`, '--input', '-'], {
      input: json({ tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.sha }] }),
    }),
  ) as { sha: string };
  const commit = JSON.parse(
    await gh(['api', '-X', 'POST', `repos/${repo}/git/commits`, '--input', '-'], {
      input: json({ message: 'Initialize Bugpatrol report assets', tree: tree.sha, parents: [] }),
    }),
  ) as { sha: string };
  await gh(['api', '-X', 'POST', `repos/${repo}/git/refs`, '--input', '-'], {
    input: json({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  });
}

export async function uploadImage(
  gh: Gh,
  repo: string,
  branch: string,
  localPath: string,
  issueId: string,
): Promise<string> {
  const bytes = await readFile(localPath);
  const remotePath = `${issueId}/${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}-${basename(localPath)}`;
  try {
    await gh(['api', `repos/${repo}/contents/${remotePath}?ref=${encodeURIComponent(branch)}`]);
  } catch (error) {
    if (!missing(error)) throw error;
    await gh(['api', '-X', 'PUT', `repos/${repo}/contents/${remotePath}`, '--input', '-'], {
      input: json({ message: 'Bugpatrol report image', content: bytes.toString('base64'), branch }),
    });
  }
  return `https://github.com/${repo}/blob/${branch}/${remotePath}?raw=true`;
}

export async function ensureLabels(gh: Gh, repo: string, labels: string[]): Promise<void> {
  for (const label of labels)
    try {
      await gh(['label', 'create', label, '--repo', repo, '--color', '5319e7', '--description', 'Filed by Bugpatrol']);
    } catch (error) {
      if (!/already exists/i.test(errorText(error))) throw error;
    }
}

export function limitBody(body: string): string {
  return body.length <= 60_000
    ? body
    : `${body.slice(0, 60_000)}\n\n…(cut; the full report is in the Bugpatrol dashboard)`;
}

async function withBody<T>(body: string, run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-gh-'));
  const file = join(dir, 'body.md');
  try {
    await writeFile(file, limitBody(body));
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fromUrl = (url: string) => ({ url: url.trim(), number: Number(url.trim().split('/').at(-1)) });

export async function createPr(
  gh: Gh,
  input: {
    repo: string;
    defaultBranch: string;
    title: string;
    body: string;
    labels: string[];
    draft: boolean;
    fix: FixProposal;
    issue: Issue;
    commitMessage: string;
    memoryRoot?: string;
  },
): Promise<{ number: number; url: string }> {
  const { fix } = input;
  if (await git(fix.worktree, 'status', '--porcelain')) {
    await git(fix.worktree, 'add', '-A');
    const committed = await commitFix(fix.worktree, input.issue.title, input.commitMessage);
    if (!committed.ok) {
      if (input.memoryRoot)
        await new Workspace(input.memoryRoot).upsertLessons([
          {
            role: 'fixer',
            source: 'commit-hook',
            text: `The commit hook rejected a commit: ${committed.reason}. Make the change pass it.`.slice(0, 200),
          },
        ]);
      throw new Error(committed.reason);
    }
    fix.commit = await git(fix.worktree, 'rev-parse', 'HEAD');
    if (fix.error?.startsWith('Left uncommitted')) fix.error = undefined;
  }
  if (!fix.commit) {
    // A fix from before Bugpatrol recorded its commit: trust the branch head
    // only when the branch has commits of its own past the default branch.
    await git(fix.worktree, 'fetch', '-q', 'origin', input.defaultBranch);
    const own = Number(await git(fix.worktree, 'rev-list', '--count', `origin/${input.defaultBranch}..HEAD`));
    if (own > 0) fix.commit = await git(fix.worktree, 'rev-parse', 'HEAD');
  }
  if (!fix.commit) throw new Error('The fix branch has no fix commit.');
  await git(fix.worktree, 'push', '-u', 'origin', fix.branch);
  return withBody(input.body, async (file) =>
    fromUrl(
      await gh(
        [
          'pr',
          'create',
          '--repo',
          input.repo,
          '--base',
          input.defaultBranch,
          '--head',
          fix.branch,
          '--title',
          input.title,
          '--body-file',
          file,
          ...(input.draft ? ['--draft'] : []),
          ...input.labels.flatMap((label) => ['--label', label]),
        ],
        { cwd: fix.worktree },
      ),
    ),
  );
}

export async function createIssue(
  gh: Gh,
  input: { repo: string; title: string; body: string; labels: string[] },
): Promise<{ number: number; url: string }> {
  return withBody(input.body, async (file) =>
    fromUrl(
      await gh([
        'issue',
        'create',
        '--repo',
        input.repo,
        '--title',
        input.title,
        '--body-file',
        file,
        ...input.labels.flatMap((label) => ['--label', label]),
      ]),
    ),
  );
}

/**
 * The committed routine that reproduces a Bugpatrol issue, found from the
 * issue number alone: the body names it, and `root` holds the committed
 * routines. Undefined for an issue with no marker or a routine that is gone.
 */
export async function issueRepro(gh: Gh, repo: string, number: number, root: string): Promise<Routine | undefined> {
  const body = await gh(['issue', 'view', String(number), '--repo', repo, '--json', 'body', '-q', '.body']);
  const id = reproRoutineId(body);
  return id ? new Workspace(root).readRoutine(id) : undefined;
}

export async function closeIssue(
  gh: Gh,
  repo: string,
  number: number,
  comment: string,
  reason: 'completed' | 'not planned',
): Promise<void> {
  await gh(['issue', 'close', String(number), '--repo', repo, '--comment', comment, '--reason', reason]);
}

export async function closeOnGitHub(
  root: string,
  config: BugpatrolConfig,
  issue: Issue,
  gh: Gh = defaultGh,
  onLog: (message: string) => void = console.error,
): Promise<void> {
  if (!config.agents.github.enabled || !issue.github) return;
  try {
    const ready = await ghReady(gh);
    if (!ready.ok) {
      onLog(ready.reason);
      return;
    }
    const { repo } = await resolveRepo(gh, config, resolve(root, config.app.source));
    await closeIssue(
      gh,
      repo,
      issue.github.number,
      issue.closedBy?.reason ?? 'Fixed by Bugpatrol',
      issue.status === 'dismissed' ? 'not planned' : 'completed',
    );
  } catch (error) {
    onLog(`GitHub close failed: ${String(error)}`);
  }
}
