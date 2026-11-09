import { execFile } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sweepCases } from '@bugpatrol/contract';
import { type AgentsFile, agentFiles, type BugpatrolConfig } from '@bugpatrol/core';
import { ApiDriver, apiCredentials, type Driver, createDriver as makeDriver } from '@bugpatrol/drivers';
import { externalBackend, probeDeploy } from './deploy.js';
import { syncGitHub } from './github.js';
import { startApp } from './lifecycle.js';
import { withSessionLogs } from './logs.js';
import { watchCi } from './roles/ci.js';
import { runExplorer } from './roles/explorer.js';
import { runJudge } from './roles/judge.js';
import { runPublisher } from './roles/publish.js';
import { recheckMerged, runFixCycle } from './roles/retest.js';
import { cleanWorktrees } from './roles/worktrees.js';
import { createRuntime } from './runtime/index.js';
import { AgentSession } from './session.js';
import { pullState, pushState, stateBranch } from './state-branch.js';
import { runSweep } from './sweep.js';
import { pendingCandidates } from './tools/judge.js';
import type { RoleOutcome } from './types.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}

/**
 * True when the source repo has uncommitted changes to tracked files. The
 * routines and the app maps of every profile do not count: the patrol writes them itself and
 * leaves them for the user to commit (ADR 0006).
 */
async function dirty(root: string, source: string): Promise<boolean> {
  const own = agentFiles(root)
    .map((path) => relative(source, path))
    .filter((path) => !path.startsWith('..'));
  const exclude = own.map((path) => `:(exclude)${path}`);
  return Boolean(await git(source, 'status', '--porcelain', '--untracked-files=no', '--', '.', ...exclude));
}

/**
 * Check out the latest `patrol.pull` commit in the source repository, so each
 * cycle tests the latest code. A detached HEAD works in a linked worktree, where
 * another worktree can hold the branch. A failure keeps the current checkout.
 */
export async function pullSource(
  root: string,
  config: BugpatrolConfig,
  onLog?: (message: string) => void,
): Promise<boolean> {
  const target = config.agents.patrol.pull;
  if (!target) return false;
  const slash = target.indexOf('/');
  const remote = target.slice(0, slash);
  const branch = target.slice(slash + 1);
  const source = resolve(root, config.app.source);
  try {
    if (await dirty(root, source)) {
      onLog?.(`Did not pull ${target}: the source repository has uncommitted changes.`);
      return false;
    }
    await git(source, 'fetch', '-q', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
    const from = await checkoutOf(source);
    await git(source, 'checkout', '-q', '--detach', `${remote}/${branch}`);
    const at = await git(source, 'rev-parse', '--short', 'HEAD');
    onLog?.(
      from?.branch
        ? `Pulled ${target} at ${at}, a detached HEAD: the checkout was on branch ${from.branch}.`
        : `Pulled ${target} at ${at}.`,
    );
    return true;
  } catch (error) {
    const reason = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    onLog?.(`Did not pull ${target}: ${reason}. The cycle uses the current checkout.`);
    return false;
  }
}

/** Where a checkout is: its commit, and its branch unless HEAD is detached. */
type Checkout = { commit: string; branch?: string };

async function checkoutOf(source: string): Promise<Checkout | undefined> {
  try {
    const commit = await git(source, 'rev-parse', 'HEAD');
    const branch = await git(source, 'symbolic-ref', '--short', '-q', 'HEAD').catch(() => '');
    return { commit, ...(branch && { branch }) };
  } catch {
    return undefined;
  }
}

const describeCheckout = (at: Checkout) => (at.branch ? `branch ${at.branch}` : `commit ${at.commit.slice(0, 7)}`);

/**
 * Puts the source checkout back where it was when the patrol started, after
 * pullSource moved it, so a one-off cycle in the checkout where someone works
 * does not leave their branch behind a detached HEAD. A checkout that git
 * refuses, for example over a local change, stays as it is, and the log says
 * how to go back.
 */
async function restoreSource(source: string, from: Checkout, onLog?: (message: string) => void): Promise<void> {
  const now = await checkoutOf(source);
  if (!now || (now.commit === from.commit && now.branch === from.branch)) return;
  const tested = now.commit.slice(0, 7);
  try {
    await git(source, 'checkout', '-q', ...(from.branch ? [from.branch] : ['--detach', from.commit]));
    onLog?.(`Put the checkout back on ${describeCheckout(from)}. The cycle tested ${tested}.`);
  } catch (error) {
    const reason = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    onLog?.(
      `Left HEAD detached at ${tested}; it was on ${describeCheckout(from)}. Run \`git checkout ${from.branch ?? from.commit}\` in ${source} to go back. Git said: ${reason}`,
    );
  }
}

/** The HEAD commit of the source repository, or undefined when it has uncommitted changes. */
export async function sourceCommit(root: string, config: BugpatrolConfig): Promise<string | undefined> {
  const source = resolve(root, config.app.source);
  try {
    if (await dirty(root, source)) return undefined;
    return await git(source, 'rev-parse', 'HEAD');
  } catch {
    return undefined;
  }
}

/**
 * The revision that a session outside a patrol tests: the source commit. An
 * external backend's revision is its deploy, which only a patrol probes.
 */
export async function sessionRevision(root: string, config: BugpatrolConfig): Promise<string | undefined> {
  return externalBackend(config.app) ? undefined : sourceCommit(root, config);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid of a patrol that another live process runs. One machine runs one app at a time. */
export function activePatrolPid(patrol: AgentsFile['patrol']): number | undefined {
  return patrol?.state === 'running' && patrol.pid && patrol.pid !== process.pid && alive(patrol.pid)
    ? patrol.pid
    : undefined;
}

function wait(minutes: number): Promise<void> {
  return new Promise<void>((done) => {
    const finish = () => {
      clearTimeout(timer);
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      done();
    };
    const timer = setTimeout(finish, minutes * 60_000);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

export type PatrolOptions = {
  root: string;
  config: BugpatrolConfig;
  once?: boolean;
  /** Run the first cycle also when the commit did not change. */
  force?: boolean;
  onLog?: (message: string) => void;
  createDriver?: typeof makeDriver;
  createRuntime?: typeof createRuntime;
};

export type PatrolResult = {
  /** What went wrong in the cycles, for example a failed setup or a retest error. */
  problems: string[];
};

/**
 * Every cycle owns app setup, driver connection, roles, and teardown. A cycle
 * that fails does not stop a patrol: the error goes in `problems`, and the
 * next cycle tries again.
 */
/** An error or a timeout is a failed cycle, so the next cycle tests the commit again. A full step count is a normal end. */
function unfinished(role: string, outcome: RoleOutcome): void {
  if (outcome.stop === 'error' || outcome.stop === 'timeout') {
    throw new Error(`${role} did not finish (${outcome.stop}): ${outcome.error ?? outcome.summary ?? 'no result'}`);
  }
}

export async function runPatrol(options: PatrolOptions): Promise<PatrolResult> {
  const problems: string[] = [];
  const { root, config } = options;
  const workspace = new Workspace(root, config.profile);
  const previous = (await workspace.readAgents()).patrol;
  // A cron job can start a patrol while the last one still runs.
  const running = activePatrolPid(previous);
  if (running) {
    options.onLog?.(`A patrol already runs (pid ${running}): did not start another.`);
    return { problems };
  }
  const runtime = options.createRuntime ?? createRuntime;
  let interrupted = false;
  let activeSession: AgentSession | undefined;
  const onSignal = () => {
    interrupted = true;
    if (activeSession) {
      activeSession.cancelled = true;
    }
  };
  const idle = () =>
    workspace.setPatrol({
      state: 'stopped',
      nextAt: new Date(Date.now() + config.agents.patrol.intervalMinutes * 60_000).toISOString(),
    });
  // The commit of the last full cycle, also from an earlier run, so a cron job
  // with --once tests only new commits. --force tests the first cycle anyway.
  let tested = options.force ? undefined : previous?.commit;
  const shared = config.agents.patrol.state === 'branch';
  const source = resolve(root, config.app.source);
  const startedAt = config.agents.patrol.pull ? await checkoutOf(source) : undefined;
  const branch = stateBranch(config.profile);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    for (let cycle = 1; !interrupted; cycle++) {
      if (config.agents.patrol.cycles && cycle > config.agents.patrol.cycles) {
        break;
      }
      if (cycle > 1) {
        await wait(config.agents.patrol.intervalMinutes);
        if (interrupted) break;
      }
      await workspace.setPatrol({ state: 'running', cycle, startedAt: new Date().toISOString() });
      await pullSource(root, config, options.onLog);
      if (shared) {
        try {
          const { changed } = await pullState(root, branch, config.profile);
          options.onLog?.(`Pulled the state from ${branch}: ${changed} file(s) changed.`);
          // Another writer may have tested a newer commit. --force still tests the first cycle.
          if (!(options.force && cycle === 1)) tested = (await workspace.readAgents()).patrol?.commit ?? tested;
        } catch (error) {
          problems.push(`Cycle ${cycle}: did not pull the state: ${String(error)}`);
          options.onLog?.(problems.at(-1)!);
        }
      }
      if (config.agents.github.enabled) await syncGitHub(root, config, { onLog: options.onLog });
      await cleanWorktrees(root, config, { onLog: options.onLog });
      // An external backend changes only with a deploy, so its trigger is the
      // deployed commit, not the source commit (T5). Without a version
      // endpoint, each cycle of the schedule explores.
      const external = externalBackend(config.app);
      const deploy = external ? await probeDeploy(root, config) : undefined;
      const commit = external
        ? deploy && 'commit' in deploy
          ? deploy.commit
          : undefined
        : await sourceCommit(root, config);
      // An old commit needs no new explore or judge. The work that is not done
      // yet (fixes, retests, publish, CI) still runs, so it never waits for a merge.
      const fresh = deploy && 'pending' in deploy ? false : !commit || commit !== tested;
      if (deploy && 'pending' in deploy) {
        options.onLog?.(
          `The deploy is not settled (${deploy.pending}): skipped explore and judge. ` +
            'The pending fixes, retests, publish, and CI checks still run.',
        );
      } else if (!fresh) {
        options.onLog?.(
          `No new ${external ? 'deploy' : 'commit'} since the last cycle (${commit!.slice(0, 7)}): skipped explore and judge. ` +
            'The pending fixes, retests, publish, and CI checks still run.',
        );
      }
      const before = problems.length;
      if (fresh) {
        for (const role of ['explorer', 'judge', 'fixer'] as const) {
          if (!config.agents[role].enabled) {
            await workspace.setAgentStatus(role, { state: 'off' });
          }
        }
        const vars = new Vars(config.app.secrets);
        let app: Awaited<ReturnType<typeof startApp>> | undefined;
        let driver: Driver | undefined;
        try {
          app = await startApp(config.app, { root, vars, emit: options.onLog, profile: config.profile });
          driver = (options.createDriver ?? makeDriver)(
            config,
            vars.resolveStrict.bind(vars),
            (value) => vars.redact(value) as string,
            resolve(root, config.app.source),
            app.contract,
            app.writes,
          );
          await driver.connect();
          let explorerId: string | undefined;
          // L14: an explorer that runs out of time still has candidates, so the judge runs before the cycle fails.
          let timedOut: RoleOutcome | undefined;
          if (config.agents.explorer.enabled && !interrupted) {
            const record = await workspace.startSession('explorer', commit);
            explorerId = record.id;
            const session = new AgentSession(root, config, vars, record.id, 'explorer', driver, options.onLog);
            activeSession = session;
            try {
              await withSessionLogs(
                { config, root, vars, onLog: options.onLog, workspace, session: record },
                async () => {
                  // An api app gets the deterministic sweep first, in the same session, so the
                  // judge sees its candidates with the explorer's.
                  if (!interrupted && driver instanceof ApiDriver) {
                    const sweep = await runSweep(
                      session,
                      sweepCases(driver.policy.contract, {
                        credentials: apiCredentials(config.app.connect, (value) => value),
                      }),
                      config.agents.sweep,
                    );
                    options.onLog?.(
                      `Sweep: ${sweep.requests} request(s), ${sweep.findings.length} finding(s), ` +
                        `${sweep.remaining} case(s) left for the next cycle.`,
                    );
                  }
                  if (!interrupted) {
                    const outcome = await runExplorer(session, runtime(config.agents.explorer.use));
                    if (outcome.stop === 'timeout') timedOut = outcome;
                    else unfinished('Explorer', outcome);
                  } else {
                    await workspace.endSession(record.id, { summary: 'Interrupted' });
                  }
                },
              );
            } finally {
              activeSession = undefined;
            }
          }
          if (config.agents.judge.enabled && explorerId && !interrupted) {
            const record = await workspace.startSession('judge');
            const session = new AgentSession(root, config, vars, record.id, 'judge', undefined, options.onLog);
            activeSession = session;
            // The judge reads every finding that waits, also from an earlier
            // session (a sweep alone, a cycle that stopped), not only this one,
            // when that session tested this revision: a finding recorded at
            // another one may be fixed in this one.
            const earlier: string[] = [];
            const stale: { id: string; candidates: number }[] = [];
            for (const { id, revision } of await workspace.listSessions(Infinity)) {
              if (id === explorerId) continue;
              const waiting = (await pendingCandidates(session, [id])).length;
              if (!waiting) continue;
              // Two unknown revisions are not one revision: a dirty or untracked source has none.
              if (commit && revision === commit) earlier.push(id);
              else stale.push({ id, candidates: waiting });
            }
            if (stale.length)
              options.onLog?.(
                `Did not judge ${stale.reduce((sum, item) => sum + item.candidates, 0)} candidate(s) of ` +
                  `${stale.length} earlier session(s) recorded at another revision than ${commit?.slice(0, 7) ?? 'this unknown one'}: ` +
                  `${stale.map((item) => item.id).join(', ')}. Judge one with \`bugpatrol judge --session <id>\`.`,
              );
            unfinished(
              'Judge',
              await runJudge(session, runtime(config.agents.judge.use), { sessionIds: [explorerId, ...earlier] }),
            );
          }
          if (timedOut) unfinished('Explorer', timedOut);
        } catch (error) {
          activeSession = undefined;
          const problem = `Cycle ${cycle}: ${String(error)}`;
          problems.push(problem);
          options.onLog?.(problem);
        } finally {
          try {
            await driver?.close();
          } finally {
            await app?.stop();
          }
        }
      }
      if (!interrupted && config.agents.explorer.enabled && config.agents.judge.enabled) {
        await recheckMerged(root, config, {
          createDriver: options.createDriver,
          createRuntime: options.createRuntime,
          onLog: options.onLog,
          onSession: (session) => {
            activeSession = session;
          },
          isInterrupted: () => interrupted,
        });
      }
      const fixes = interrupted
        ? []
        : await runFixCycle(root, config, {
            createDriver: options.createDriver,
            createRuntime: options.createRuntime,
            onLog: options.onLog,
            onSession: (session) => {
              activeSession = session;
            },
            isInterrupted: () => interrupted,
          });
      for (const fix of fixes) {
        const last = fix.retests?.at(-1);
        if (last?.outcome === 'error')
          problems.push(`Cycle ${cycle}: the retest of ${fix.issueId} failed: ${last.reason}`);
      }
      // Only a failed test run tests the commit again. A red CI check is the PR's problem, not the cycle's.
      const cycleFailed = problems.length > before;
      if (!interrupted && config.agents.github.enabled) {
        const outcomes = await runPublisher(root, config, {
          createRuntime: options.createRuntime,
          onLog: options.onLog,
          onSession: (session) => {
            activeSession = session;
          },
        });
        for (const item of outcomes.filter((outcome) => outcome.kind === 'unpublished')) {
          problems.push(`Cycle ${cycle}: ${item.issueId} was not published: ${item.reason}`);
          options.onLog?.(problems.at(-1)!);
        }
      }
      if (!interrupted && config.agents.github.enabled) {
        const ci = await watchCi(root, config, {
          createRuntime: options.createRuntime,
          onLog: options.onLog,
          wait: true,
        });
        problems.push(...ci.problems.map((problem) => `Cycle ${cycle}: ${problem}`));
      }
      if (!interrupted && config.agents.github.enabled) await syncGitHub(root, config, { onLog: options.onLog });
      // A cycle with a problem tests the commit again next time.
      if (!interrupted && fresh && commit && !cycleFailed) {
        tested = commit;
        await workspace.setPatrol({ commit });
      }
      if (shared) {
        try {
          const { commit: pushed } = await pushState(root, branch, config.profile);
          options.onLog?.(
            pushed ? `Pushed the state to ${branch} at ${pushed.slice(0, 7)}.` : 'The shared state did not change.',
          );
        } catch (error) {
          problems.push(`Cycle ${cycle}: did not push the state: ${String(error)}`);
          options.onLog?.(problems.at(-1)!);
        }
      }
      await idle();
      if (options.once || interrupted) {
        break;
      }
    }
  } finally {
    if (startedAt) await restoreSource(source, startedAt, options.onLog);
    // No cycle follows, so the dashboard must not show a next patrol.
    await workspace.setPatrol({ state: 'stopped', nextAt: undefined });
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return { problems };
}
