import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { type FixProposal, type Issue, judgedRetests, paths, type RoutineStep } from '@bugpatrol/core';
import { fixerSystem } from '../prompts.js';
import type { AgentSession } from '../session.js';
import { lessonTools } from '../tools/memory.js';
import type { RoleOutcome, Runtime, Tool } from '../types.js';
import { lessonsFor } from '../workspace.js';

const exec = promisify(execFile);
const ranks = {
  cosmetic: 0,
  minor: 1,
  major: 2,
  critical: 3,
};
const result = (text: string) => ({ content: [{ type: 'text' as const, text }] });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const output = await exec('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return output.stdout.trim();
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function confined(worktree: string, path: string): string {
  const file = resolve(worktree, path);
  if (file !== worktree && !file.startsWith(worktree + sep)) throw new Error('Path leaves worktree');
  return file;
}

async function existingPath(worktree: string, path: string): Promise<string> {
  const file = confined(worktree, path);
  const real = await realpath(file);
  if (real !== worktree && !real.startsWith(worktree + sep)) throw new Error('Path leaves worktree');
  return file;
}

export function modelTools(worktree: string): Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file in the worktree.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      async run(input) {
        const path = await existingPath(worktree, String(input.path));
        return result(await readFile(path, 'utf8'));
      },
    },
    {
      name: 'list_files',
      description: 'List files in a directory.',
      inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
      async run(input) {
        const path = await existingPath(worktree, String(input.dir ?? '.'));
        return result((await readdir(path)).join('\n'));
      },
    },
    {
      name: 'search',
      description: 'Search tracked files with git grep.',
      inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
      async run(input) {
        try {
          return result((await git(worktree, 'grep', '-n', String(input.pattern))).slice(-4000));
        } catch {
          return result('No matches');
        }
      },
    },
    {
      name: 'write_file',
      description: 'Write a file in the worktree.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      async run(input) {
        const file = confined(worktree, String(input.path));
        const parent = resolve(file, '..');
        const real = await realpath(parent);
        if (real !== worktree && !real.startsWith(worktree + sep)) throw new Error('Path leaves worktree');
        try {
          await existingPath(worktree, String(input.path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await writeFile(file, String(input.content));
        return result(`Wrote ${relative(worktree, file)}`);
      },
    },
    {
      name: 'run',
      description: 'Run a command in the worktree with a five-minute timeout.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      async run(input) {
        try {
          const output = await exec('/bin/sh', ['-c', String(input.command)], {
            cwd: worktree,
            timeout: 300_000,
            maxBuffer: 4 * 1024 * 1024,
          });
          return result((output.stdout + output.stderr).slice(-4000));
        } catch (error) {
          return { ...result(String(error).slice(-4000)), isError: true };
        }
      },
    },
  ];
}

export function finishTool(): Tool {
  return {
    name: 'finish',
    description: 'Finish with a summary.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
    async run(input) {
      return { ...result(String(input.summary ?? '')), done: true };
    },
  };
}

/**
 * The configured message (default `fix: <title>`), cut to 72 characters: the
 * plain conventional form, which most repositories accept. A rejection returns the hook's
 * last line so the dashboard can say why.
 */
export async function commitFix(
  worktree: string,
  title: string,
  template: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const lowered = `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  const subject = template.replaceAll('{title}', lowered);
  const message = subject.length > 72 ? `${subject.slice(0, 69).trimEnd()}...` : subject;
  try {
    await git(worktree, 'commit', '-m', message);
    return { ok: true };
  } catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    const lines = `${output.stderr ?? ''}\n${output.stdout ?? ''}`.split('\n').map((line) => line.trim());
    const reason = lines
      .filter((line) => /✗|error|not allowed|fail/i.test(line))
      .slice(0, 2)
      .join(' ');
    return { ok: false, reason: reason || 'the commit hook rejected the commit' };
  }
}

/**
 * Links each .env file that git ignores in the source checkout into the
 * worktree, at the same path. Git does not copy ignored files, and an app or
 * its E2E harness often reads its keys from them. A link, not a copy, so a
 * key that changes in the checkout changes in every worktree. A file that the
 * worktree already has stays as it is.
 */
export async function linkEnvFiles(source: string, worktree: string): Promise<string[]> {
  let listed: string;
  try {
    listed = await git(source, 'ls-files', '--others', '--ignored', '--exclude-standard', '--', ':(glob)**/.env*');
  } catch {
    return [];
  }
  const linked: string[] = [];
  for (const file of listed.split('\n').filter(Boolean)) {
    if (!/^\.env(\.|$)/.test(basename(file)) || file.split('/').includes('node_modules')) continue;
    const target = join(worktree, file);
    try {
      await lstat(target);
      continue;
    } catch {
      // Not in the worktree yet.
    }
    await mkdir(dirname(target), { recursive: true });
    await symlink(join(source, file), target);
    linked.push(file);
  }
  return linked;
}

/**
 * Reads the issue again before the write. A fix takes minutes, and a human
 * may close the issue meanwhile; a human decision is never overwritten.
 */
async function updateIssue(session: AgentSession, id: string, patch: Partial<Issue>): Promise<void> {
  const current = await session.workspace.readIssue(id);
  if (!current || current.status === 'dismissed') return;
  await session.workspace.saveIssue({ ...current, ...patch });
}

/** Each issue gets an isolated branch; a proposal is committed locally after verification. */
export async function runFixer(
  session: AgentSession,
  runtime: Runtime,
  opts: { issueIds?: string[] } = {},
): Promise<FixProposal[]> {
  const config = session.config.agents.fixer;
  const source = resolve(session.root, session.config.app.source);
  const all = await session.workspace.listIssues();
  const fixes = await session.workspace.listFixes();
  // A 'running' proposal older than the time limit belongs to a fixer that
  // was killed; without this, its issue would wait for it forever.
  const abandoned = (fix: FixProposal) =>
    fix.status === 'running' && Date.now() - Date.parse(fix.startedAt) > config.timeoutMs;
  const failed = new Set(fixes.filter((fix) => fix.status === 'failed' || abandoned(fix)).map((fix) => fix.issueId));
  const retry = new Map(
    fixes
      .filter(
        (fix) =>
          ['proposed', 'retesting'].includes(fix.status) &&
          fix.retests?.at(-1)?.outcome === 'not-fixed' &&
          judgedRetests(fix.retests).length < config.retest.attempts,
      )
      .map((fix) => [fix.issueId, fix]),
  );
  const eligible = all.filter((issue) => {
    if (issue.status === 'dismissed') return false;
    if (opts.issueIds && !opts.issueIds.includes(issue.id)) return false;
    if (
      !opts.issueIds &&
      (issue.fixRejected || fixes.some((fix) => fix.issueId === issue.id && fix.status === 'rejected'))
    )
      return false;
    const pending = ['new', 'filed'].includes(issue.status) || failed.has(issue.id) || retry.has(issue.id);
    return (
      pending &&
      (!issue.fixId ||
        failed.has(issue.id) ||
        retry.has(issue.id) ||
        fixes.some((fix) => fix.issueId === issue.id && fix.worktreeRemovedAt) ||
        (opts.issueIds && fixes.some((fix) => fix.issueId === issue.id && fix.status === 'rejected'))) &&
      ranks[issue.severity] >= ranks[config.minSeverity]
    );
  });
  // A fixer run is minutes of a coding agent. The worst issues go first, and
  // the rest wait for the next cycle instead of queueing an hour of work.
  const selected = opts.issueIds
    ? eligible
    : eligible
        .sort((a, b) => ranks[b.severity] - ranks[a.severity] || b.occurrences - a.occurrences)
        .slice(0, config.maxPerCycle);
  const proposals: FixProposal[] = [];
  await session.activity(`Fixing ${selected.length} issue(s)`, 0, runtime.label);
  for (const issue of selected) {
    // A stop request ends the queue between fixes, never inside one.
    if (session.cancelled) break;
    const oldFix = fixes.find((fix) => fix.issueId === issue.id);
    const baseBranch = `bugpatrol/fix-${issue.id}`;
    let branch = baseBranch;
    if (
      oldFix?.worktreeRemovedAt &&
      ((await branchExists(source, oldFix.branch)) || (await branchExists(source, baseBranch)))
    ) {
      let n = 2;
      while (await branchExists(source, `${baseBranch}-${n}`)) n++;
      branch = `${baseBranch}-${n}`;
    }
    const worktree = join(paths.worktrees(session.root), issue.id);
    await mkdir(paths.worktrees(session.root), { recursive: true });
    let existing = false;
    try {
      await realpath(worktree);
      existing = true;
    } catch {
      await git(source, 'worktree', 'add', '-b', branch, worktree, 'HEAD');
    }
    if (existing && failed.has(issue.id)) {
      const base = await git(worktree, 'merge-base', 'HEAD', await git(source, 'rev-parse', 'HEAD'));
      await git(worktree, 'reset', '--hard', base);
      await git(worktree, 'clean', '-fd');
    }
    await linkEnvFiles(source, worktree);
    // A new worktree has no dependencies. Install them before the fixer
    // starts, so that it can run the type check and the tests.
    if (!existing && config.retest.prepare) {
      session.emit({ kind: 'fix', summary: `Preparing the worktree: ${config.retest.prepare}` });
      try {
        await exec('/bin/sh', ['-c', config.retest.prepare], {
          cwd: worktree,
          timeout: 600_000,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        session.emit({
          kind: 'error',
          summary: `The prepare command failed in the worktree: ${String(error).slice(0, 200)}`,
        });
      }
    }
    const previous = retry.get(issue.id);
    const proposal: FixProposal = {
      ...previous,
      version: 1,
      id: `fix_${issue.id}`,
      issueId: issue.id,
      status: 'running',
      runtime: runtime.label,
      repo: source,
      branch,
      worktree,
      worktreeRemovedAt: undefined,
      ...(oldFix?.worktreeRemovedAt ? { pr: undefined, commit: undefined } : {}),
      startedAt: previous?.startedAt ?? new Date().toISOString(),
      error: undefined,
    };
    await session.workspace.saveFix(proposal);
    await session.workspace.saveIssue({ ...issue, status: 'fixing' });
    session.emit({ kind: 'fix', summary: `Fixing ${issue.title}` });
    try {
      const outcome = await runOne(session, runtime, issue, worktree, previous?.retests?.at(-1));
      if (outcome.stop !== 'done') {
        throw new Error(outcome.error ?? `Fixer stopped: ${outcome.stop}`);
      }
      proposal.costUsd = (previous?.costUsd ?? 0) + outcome.costUsd;
      proposal.summary = outcome.summary;
      await git(worktree, 'add', '-A');
      const newDiff = await git(worktree, 'diff', '--cached');
      const sourceHead = await git(source, 'rev-parse', 'HEAD');
      const base = await git(worktree, 'merge-base', 'HEAD', sourceHead);
      proposal.diffStat = await git(worktree, 'diff', '--cached', '--stat', base);
      proposal.diff = Buffer.from(await git(worktree, 'diff', '--cached', base))
        .subarray(0, 200_000)
        .toString('utf8');
      if (!newDiff && previous) {
        // A refix that changes nothing keeps the earlier change: it is still
        // the proposal, and the retest verdict tells the team it did not work.
        proposal.status = 'proposed';
        proposal.endedAt = new Date().toISOString();
        await session.workspace.saveFix(proposal);
        await updateIssue(session, issue.id, { status: 'fix-proposed', fixId: proposal.id });
        proposals.push(proposal);
        continue;
      }
      if (!newDiff) {
        // No change plus an explanation is a finding too: the fixer read the
        // code and says the report is wrong or the behaviour is intended.
        proposal.status = outcome.summary ? 'declined' : 'failed';
        if (proposal.status === 'declined')
          await session.workspace.upsertLessons([
            {
              role: 'judge',
              source: 'fixer-decline',
              scope: issue.screenId,
              text: `Likely by design: ${issue.title} — ${outcome.summary?.split(/(?<=[.!?])\s/)[0] ?? ''}`.slice(
                0,
                200,
              ),
            },
          ]);
        if (!outcome.summary) proposal.error = 'The fixer made no change and gave no reason.';
        await updateIssue(session, issue.id, { status: issue.status });
        proposal.endedAt = new Date().toISOString();
        await session.workspace.saveFix(proposal);
        proposals.push(proposal);
        continue;
      }
      if (config.verify) {
        try {
          await exec('/bin/sh', ['-c', config.verify], {
            cwd: worktree,
            timeout: 300_000,
            maxBuffer: 4 * 1024 * 1024,
          });
        } catch (error) {
          const output = error as Error & { stdout?: string; stderr?: string };
          const last = (output.stderr || output.stdout || output.message).trim().split('\n').at(-1) ?? 'unknown error';
          await session.workspace.upsertLessons([
            {
              role: 'fixer',
              source: 'verify',
              text: `The verify command failed with: ${last}. Run it before you finish.`.slice(0, 200),
            },
          ]);
          throw new Error(`Verification failed: ${(output.stderr || output.stdout || output.message).slice(-4000)}`, {
            cause: error,
          });
        }
      }
      proposal.checks = config.verify;
      proposal.status = 'proposed';
      const committed = await commitFix(worktree, issue.title, config.commitMessage);
      if (!committed.ok) {
        await session.workspace.upsertLessons([
          {
            role: 'fixer',
            source: 'commit-hook',
            text: `The commit hook rejected a commit: ${committed.reason}. Make the change pass it.`.slice(0, 200),
          },
        ]);
        // The diff is the proposal; a commit is only a convenience. A repo's
        // commit hook (scope rules, lint) must never throw a good fix away,
        // and Bugpatrol never bypasses a hook with --no-verify.
        proposal.error = `Left uncommitted in the worktree: ${committed.reason}`;
      } else {
        proposal.commit = await git(worktree, 'rev-parse', 'HEAD');
      }
      if (
        committed.ok &&
        config.retest.enabled &&
        session.config.agents.explorer.enabled &&
        session.config.agents.judge.enabled &&
        (issue.evidence.routineId || issue.evidence.steps?.length || issue.candidateIds.length)
      )
        proposal.status = 'retesting';
      await updateIssue(session, issue.id, { status: 'fix-proposed', fixId: proposal.id });
    } catch (error) {
      proposal.status = 'failed';
      proposal.error = String(error);
      await updateIssue(session, issue.id, { status: issue.status });
    }
    proposal.endedAt = new Date().toISOString();
    await session.workspace.saveFix(proposal);
    proposals.push(proposal);
  }
  await session.workspace.endSession(session.sessionId, {
    summary: `${proposals.length} fix proposal(s)`,
    issues: proposals.map((item) => item.issueId),
  });
  await session.idle(proposals.reduce((sum, item) => sum + (item.costUsd ?? 0), 0));
  return proposals;
}

async function runOne(
  session: AgentSession,
  runtime: Runtime,
  issue: Issue,
  worktree: string,
  last?: NonNullable<FixProposal['retests']>[number],
): Promise<RoleOutcome> {
  const config = session.config.agents.fixer;
  const evidencePaths = Object.entries(issue.evidence)
    .filter(([key]) => ['screenshot', 'baseline', 'diff'].includes(key))
    .map(([key, value]) => `${key}: ${resolve(session.root, String(value))}`);
  const evidence = evidencePaths.join('\n');
  const steps = (issue.evidence.steps ?? []).map((step, index) => `${index + 1}. ${stepWords(step)}`);
  const repro = `Run the routine ${issue.evidence.routineId ?? '(none)'}, then:\n${steps.join('\n')}`;
  const after = last?.shots?.length
    ? last.shots
        .map(
          (shot) =>
            `${shot.screenId ?? '(unknown screen)'}: ${shot.after ? resolve(session.root, shot.after) : '(unavailable)'}`,
        )
        .join('\n')
    : last?.after
      ? resolve(session.root, last.after)
      : '(unavailable)';
  return runtime.run(
    {
      role: 'fixer',
      sessionId: session.sessionId,
      workdir: worktree,
      system: fixerSystem(lessonsFor(await session.workspace.readMemory(), 'fixer')),
      prompt:
        `Issue: ${issue.title}\nSeverity: ${issue.severity}\n${issue.body}\nEvidence:\n${evidence}\n` +
        `Reproduction: ${repro}` +
        (last
          ? `\nYour last change did not fix the issue in the running app. The QA lead said: ${last.reason}. After screenshots:\n${after}\n` +
            'First find why your last change had no effect in the running app, for example a different file that the app ' +
            'loads on this platform. Do not trust a guess from the QA lead: check the code. When you find the cause, call ' +
            'save_lesson with it, so that later fixes avoid it. Then fix the issue.'
          : ''),
      tools: [
        ...(runtime.label.startsWith('cli:') ? [] : modelTools(worktree)),
        ...lessonTools(session, 'fixer'),
        finishTool(),
      ],
      maxSteps: config.maxSteps,
      budgetUsd: config.budgetUsd,
      timeoutMs: config.timeoutMs,
    },
    session.emit,
  );
}

export function stepWords(step: RoutineStep): string {
  if (step.kind === 'tap') {
    return `Tap ${step.target.name ?? step.target.testId ?? step.target.text ?? step.target.selector ?? 'target'}`;
  }
  if (step.kind === 'type') {
    return `Type ${step.value}${step.submit ? ' and submit' : ''}`;
  }
  if (step.kind === 'scroll') return `Scroll ${step.direction}`;
  if (step.kind === 'press') return `Press ${step.key}`;
  if (step.kind === 'open') return `Open ${step.url}`;
  if (step.kind === 'window') return `Switch to window ${step.match}`;
  if (step.kind === 'wait') return `Wait ${step.ms} ms`;
  if (step.kind === 'request') return `${step.method} ${step.url}`;
  if (step.kind === 'run')
    return `Run \`${step.command}\`${step.input ? ` with the input ${JSON.stringify(step.input)}` : ''}`;
  return 'Go back';
}
