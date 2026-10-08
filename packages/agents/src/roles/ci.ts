import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { type BugpatrolConfig, ciAttempts, type FixAttempt, type FixProposal } from '@bugpatrol/core';
import { defaultGh, type Gh, ghReady, resolveRepo } from '../github.js';
import { fixerSystem } from '../prompts.js';
import { createRuntime as makeRuntime } from '../runtime/index.js';
import { AgentSession } from '../session.js';
import { lessonTools } from '../tools/memory.js';
import { Vars } from '../vars.js';
import { lessonsFor, Workspace } from '../workspace.js';
import { closeAttempt, commitFix, finishTool, modelTools } from './fixer.js';

const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

export type Check = {
  name: string;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
  link?: string;
  description?: string;
  workflow?: string;
};

export type CiDeps = {
  gh?: Gh;
  createRuntime?: typeof makeRuntime;
  onLog?: (message: string) => void;
  /** Wait for pending checks, up to `ci.waitMinutes`. */
  wait?: boolean;
  /** Only these issues. */
  issueIds?: string[];
  /** Tests make the poll instant. */
  sleep?: (ms: number) => Promise<void>;
};

/** `gh pr checks` exits with a non-zero code while a check fails or runs, but it still prints the JSON. */
export async function readChecks(gh: Gh, repo: string, pr: number): Promise<Check[]> {
  let out: string;
  try {
    out = await gh(['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,bucket,link,description,workflow']);
  } catch (error) {
    out = String((error as { stdout?: string }).stdout ?? '');
    if (!out.trim().startsWith('[')) {
      // A PR with no checks at all: gh says so on stderr.
      if (/no checks/i.test(String((error as { stderr?: string }).stderr ?? ''))) return [];
      throw error;
    }
  }
  return out.trim() ? (JSON.parse(out) as Check[]) : [];
}

/** The log of each failed GitHub Actions job, cut to the end, where the error usually is. */
async function failureLog(gh: Gh, repo: string, failed: Check[]): Promise<string> {
  const parts: string[] = [];
  const runs = new Set<string>();
  for (const check of failed) {
    const run = check.link?.match(/\/actions\/runs\/(\d+)/)?.[1];
    if (run && !runs.has(run)) {
      runs.add(run);
      try {
        const log = await gh(['run', 'view', run, '--repo', repo, '--log-failed']);
        parts.push(`### ${check.workflow || check.name} (run ${run})\n${log.split('\n').slice(-150).join('\n')}`);
        continue;
      } catch {
        /* fall back to the check summary */
      }
    }
    if (!run) parts.push(`### ${check.name}\n${check.description ?? ''}\n${check.link ?? ''}`);
  }
  return parts.join('\n\n').slice(-12_000);
}

function ciPrompt(pr: number, failed: Check[], log: string): string {
  return `The CI checks failed on PR #${pr}, which has your earlier fix. Make every check pass.

FAILED CHECKS
${failed.map((check) => `- ${check.name}${check.link ? ` (${check.link})` : ''}`).join('\n')}

THE END OF THE FAILED LOGS
${log || '(no log is available)'}

- Find the cause in the log. Fix the code or the test, not the CI config.
- Run the same command as the failed check in this worktree, and make it pass before you finish.
- Keep the original fix. Do not revert it to make CI pass.
- If the failure has nothing to do with this change (a flaky test, an outage), change nothing, and say so.`;
}

/**
 * Watches the CI checks of each open Bugpatrol PR. A failed check goes to the
 * fixer with its log. Bugpatrol commits the new change on the same branch
 * and pushes it (never with force), so the PR runs its checks again. After
 * `ci.attempts` tries, it gives up and says so, and a person takes over.
 */
export async function watchCi(
  root: string,
  config: BugpatrolConfig,
  deps: CiDeps = {},
): Promise<{ problems: string[] }> {
  const problems: string[] = [];
  const settings = config.agents.github.ci;
  if (!config.agents.github.enabled || !settings.enabled) return { problems };
  const gh = deps.gh ?? defaultGh;
  const ready = await ghReady(gh);
  if (!ready.ok) {
    deps.onLog?.(ready.reason);
    return { problems };
  }
  const workspace = new Workspace(root);
  const fixes = (await workspace.listFixes()).filter(
    (fix) => fix.pr && (fix.pr.state ?? 'open') === 'open' && (!deps.issueIds || deps.issueIds.includes(fix.issueId)),
  );
  if (!fixes.length) return { problems };
  const { repo } = await resolveRepo(gh, config, resolve(root, config.app.source));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  for (const fix of fixes) {
    const pr = fix.pr!.number;
    const deadline = Date.now() + settings.waitMinutes * 60_000;
    for (;;) {
      const checks = await readChecks(gh, repo, pr);
      const pending = checks.filter((check) => check.bucket === 'pending');
      const failed = checks.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel');
      const save = async (state: NonNullable<FixProposal['ci']>['state']) => {
        fix.ci = {
          state,
          head: fix.commit,
          failing: failed.map((check) => check.name),
          checkedAt: new Date().toISOString(),
        };
        await workspace.saveFix(fix);
      };
      if (!checks.length) {
        await save('none');
        break;
      }
      if (pending.length && !failed.length) {
        if (deps.wait && Date.now() < deadline) {
          await sleep(30_000);
          continue;
        }
        await save('pending');
        deps.onLog?.(`CI: PR #${pr} has ${pending.length} check(s) still running. The next cycle looks again.`);
        break;
      }
      if (!failed.length) {
        // A PR whose checks all skip has no passed test.
        await save(checks.some((check) => check.bucket === 'pass') ? 'passed' : 'none');
        deps.onLog?.(`CI: all ${checks.length} check(s) passed on PR #${pr}.`);
        break;
      }
      if (ciAttempts(fix.attempts).length >= settings.attempts) {
        await save('gave-up');
        const problem = `CI: PR #${pr} still fails ${failed.map((check) => check.name).join(', ')} after ${settings.attempts} fixer attempt(s). A person must look at it.`;
        problems.push(problem);
        deps.onLog?.(problem);
        break;
      }
      await save('failed');
      if (!config.agents.fixer.enabled) {
        deps.onLog?.(
          `CI: PR #${pr} failed ${failed.map((check) => check.name).join(', ')}. The fixer is off, so a person must fix it.`,
        );
        break;
      }
      try {
        await access(fix.worktree);
      } catch {
        fix.ci = { ...fix.ci!, state: 'gave-up' };
        await workspace.saveFix(fix);
        const problem = `CI: the worktree of ${fix.issueId} is gone, so the fixer cannot change PR #${pr}. A person must look at it.`;
        problems.push(problem);
        deps.onLog?.(problem);
        break;
      }
      deps.onLog?.(`CI: PR #${pr} failed ${failed.map((check) => check.name).join(', ')}. The fixer tries to fix it.`);
      const pushed = await fixCi(root, config, fix, failed, await failureLog(gh, repo, failed), deps);
      await workspace.saveFix(fix);
      if (!pushed) {
        if (ciAttempts(fix.attempts).length >= settings.attempts) {
          const problem = `CI: the fixer could not fix PR #${pr}. A person must look at it.`;
          fix.ci = { ...fix.ci!, state: 'gave-up' };
          await workspace.saveFix(fix);
          problems.push(problem);
          deps.onLog?.(problem);
          break;
        }
        continue;
      }
      if (!deps.wait) {
        fix.ci = { ...fix.ci!, state: 'pending' };
        await workspace.saveFix(fix);
        break;
      }
      // GitHub needs a moment to start the checks on the new commit.
      await sleep(30_000);
    }
  }
  return { problems };
}

/**
 * One fix attempt on a failed check, added to the fix's attempts. True when a
 * new commit went to the PR branch.
 */
async function fixCi(
  root: string,
  config: BugpatrolConfig,
  fix: FixProposal,
  failed: Check[],
  log: string,
  deps: CiDeps,
): Promise<boolean> {
  const workspace = new Workspace(root);
  const record = await workspace.startSession('fixer');
  const session = new AgentSession(
    root,
    config,
    new Vars(config.app.secrets),
    record.id,
    'fixer',
    undefined,
    deps.onLog,
  );
  const fixer = config.agents.fixer;
  const runtime = (deps.createRuntime ?? makeRuntime)(fixer.use);
  session.emit({
    kind: 'fix',
    summary: `Fixing CI on PR #${fix.pr!.number}: ${failed.map((check) => check.name).join(', ')}`,
  });
  let summary = '';
  let status: 'finished' | 'failed' = 'failed';
  const unfinished = fix.attempts?.at(-1);
  if (unfinished && !unfinished.outcome) {
    unfinished.outcome = 'abandoned';
    unfinished.reason = 'The fixer was stopped before it finished.';
    unfinished.endedAt = new Date().toISOString();
  }
  const attempt: FixAttempt = {
    n: (fix.attempts?.at(-1)?.n ?? 0) + 1,
    kind: 'ci',
    sessionId: session.sessionId,
    startedAt: new Date().toISOString(),
  };
  fix.attempts = [...(fix.attempts ?? []), attempt];
  await workspace.saveFix(fix);
  try {
    const outcome = await runtime.run(
      {
        role: 'fixer',
        sessionId: session.sessionId,
        workdir: fix.worktree,
        system: fixerSystem(lessonsFor(await workspace.readMemory(), 'fixer')),
        prompt: ciPrompt(fix.pr!.number, failed, log),
        tools: [
          ...(runtime.label.startsWith('cli:') ? [] : modelTools(fix.worktree)),
          ...lessonTools(session, 'fixer'),
          finishTool(),
        ],
        maxSteps: fixer.maxSteps,
        budgetUsd: fixer.budgetUsd,
        timeoutMs: fixer.timeoutMs,
      },
      session.emit,
    );
    summary = outcome.summary ?? '';
    attempt.costUsd = outcome.costUsd;
    if (outcome.stop !== 'done') {
      attempt.outcome = outcome.stop === 'timeout' ? 'timeout' : 'error';
      throw new Error(outcome.error ?? `Fixer stopped: ${outcome.stop}`);
    }
    if (!(await git(fix.worktree, 'status', '--porcelain'))) {
      summary = summary || 'The fixer made no change.';
      attempt.outcome = 'no-change';
      session.emit({ kind: 'fix', summary: `No change for CI on PR #${fix.pr!.number}: ${summary.split('\n')[0]}` });
      status = 'finished';
      return false;
    }
    if (fixer.verify) {
      try {
        await promisify(execFile)('/bin/sh', ['-c', fixer.verify], {
          cwd: fix.worktree,
          timeout: 300_000,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        const output = error as Error & { stdout?: string; stderr?: string };
        attempt.outcome = 'verify-failed';
        attempt.verifyOutput = (`${output.stdout ?? ''}${output.stderr ?? ''}`.trim() || output.message).slice(-4000);
        throw error;
      }
    }
    await git(fix.worktree, 'add', '-A');
    const committed = await commitFix(fix.worktree, 'pass the CI checks', fixer.commitMessage);
    if (!committed.ok) throw new Error(`The commit hook rejected the commit: ${committed.reason}`);
    fix.commit = await git(fix.worktree, 'rev-parse', 'HEAD');
    await git(fix.worktree, 'push', 'origin', fix.branch);
    session.emit({ kind: 'fix', summary: `Pushed a CI fix to PR #${fix.pr!.number} (${fix.commit.slice(0, 7)})` });
    attempt.outcome = 'proposed';
    status = 'finished';
    return true;
  } catch (error) {
    summary = String(error).slice(0, 500);
    attempt.outcome ??= 'error';
    session.emit({ kind: 'error', summary: `CI fix failed on PR #${fix.pr!.number}: ${summary}` });
    return false;
  } finally {
    attempt.reason = summary || undefined;
    await closeAttempt(workspace, fix.id, attempt, fix.worktree, fix.repo);
    await workspace.endSession(session.sessionId, { status, summary });
    await session.idle();
  }
}
