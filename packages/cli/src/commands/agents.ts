import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentSession,
  applyRetest,
  createRuntime,
  pendingCandidates,
  replayRoutine,
  retestFix,
  reviewPullRequest,
  runExplorer,
  runFixCycle,
  runJudge,
  runPatrol,
  runPublisher,
  runtimeProblem,
  startApp,
  syncGitHub,
  Vars,
  Workspace,
  watchCi,
  withSessionLogs,
} from '@bugpatrol/agents';
import { type AgentRole, type BugpatrolConfig, ConfigError, formatUsage, InfrastructureError } from '@bugpatrol/core';
import { createDriver } from '@bugpatrol/drivers';

type AgentFlags = Record<string, string | string[] | boolean | number>;

/** One line for each model that the session used, with its tokens. */
async function logUsage(workspace: Workspace, sessionId: string, log: (line: string) => void): Promise<void> {
  const session = (await workspace.listSessions(Infinity)).find((item) => item.id === sessionId);
  const byModel = Object.entries(session?.tokensByModel ?? {});
  if (!byModel.length) {
    log('Tokens: the runtime reported no token usage.');
    return;
  }
  for (const [model, usage] of byModel) log(`Tokens: ${model}: ${formatUsage(usage)}`);
}

/** Rejects ambiguous agent flags before an app or agent runtime starts. */
export function parseAgentFlags(command: string, args: string[]): AgentFlags {
  const flags: AgentFlags = {};
  if (command === 'replay') {
    if (args.length !== 1 || args[0]?.startsWith('-')) {
      throw new ConfigError('replay needs one routine id');
    }
    return { id: args[0]! };
  }
  if (command === 'review') {
    const [target, ...rest] = args;
    // A number, or the URL of the pull request.
    const number = Number(/^(?:.*\/pull\/)?(\d+)\/?$/.exec(target ?? '')?.[1]);
    if (!Number.isInteger(number) || number < 1) {
      throw new ConfigError('review needs a pull request number or URL');
    }
    flags.pr = number;
    args = rest;
  }
  const values: Record<string, string[]> = {
    explore: ['--goal', '--steps'],
    review: ['--steps'],
    judge: ['--session'],
    fix: ['--issue'],
    retest: ['--issue'],
    publish: ['--issue'],
    ci: ['--issue'],
    patrol: [],
  };
  if (!values[command]) throw new ConfigError(`Unknown agent command ${command}`);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (command === 'patrol' && (flag === '--once' || flag === '--force')) {
      flags[flag.slice(2)] = true;
      continue;
    }
    if (command === 'ci' && flag === '--wait') {
      flags.wait = true;
      continue;
    }
    if ((command === 'publish' || command === 'review') && flag === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (command === 'review' && (flag === '--force' || flag === '--allow-fork')) {
      flags[flag === '--force' ? 'force' : 'allowFork'] = true;
      continue;
    }
    if (!values[command]!.includes(flag)) {
      throw new ConfigError(`Unknown flag for ${command}: ${flag}`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      throw new ConfigError(`${flag} needs a value`);
    }
    if (flag === '--session' || flag === '--issue') {
      const key = flag.slice(2);
      const ids = [value];
      while (args[index + 1] && !args[index + 1]!.startsWith('--')) {
        ids.push(args[++index]!);
      }
      flags[key] = [...((flags[key] as string[]) ?? []), ...ids];
    } else if (flag === '--steps') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) {
        throw new ConfigError('--steps needs a positive integer');
      }
      flags.steps = number;
    } else {
      flags.goal = value;
    }
  }
  return flags;
}

/** The roles each command runs. A retest runs the explorer and the judge. */
function rolesFor(command: string, config: BugpatrolConfig): AgentRole[] {
  switch (command) {
    case 'explore':
      return ['explorer'];
    case 'judge':
    case 'publish':
      return ['judge'];
    case 'ci':
      return ['fixer'];
    case 'retest':
    case 'review':
      return ['explorer', 'judge'];
    case 'fix':
      return ['fixer', 'explorer', 'judge'];
    case 'patrol':
      return config.agents.fixer.enabled ? ['explorer', 'judge', 'fixer'] : ['explorer', 'judge'];
    default:
      return [];
  }
}

/** Every role needs an LLM: stop before the app starts when one cannot reach it. */
export function preflight(command: string, config: BugpatrolConfig, env: NodeJS.ProcessEnv = process.env): void {
  const problems = rolesFor(command, config)
    .map((role) => runtimeProblem(role, config.agents[role].use, env))
    .filter((problem): problem is string => Boolean(problem));
  if (problems.length) throw new ConfigError(problems.join('\n'));
}

/** Owns lifecycle cleanup for a single agent command, including interrupted runs. */
export async function runAgentCommand(
  command: string,
  args: string[],
  root: string,
  config: BugpatrolConfig,
  log: (message: string) => void,
): Promise<void> {
  const flags = parseAgentFlags(command, args);
  preflight(command, config);
  const workspace = new Workspace(root);
  if (command === 'patrol') {
    const { problems } = await runPatrol({
      root,
      config,
      once: Boolean(flags.once),
      force: Boolean(flags.force),
      onLog: log,
    });
    if (problems.length) {
      log(
        `The patrol had ${problems.length} problem(s):\n${problems.map((problem) => `- ${problem.split('\n')[0]}`).join('\n')}`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'ci') {
    if (!config.agents.github.enabled) {
      throw new ConfigError('GitHub is off. Set agents.github.enabled: true in .bugpatrol/bugpatrol.yml.');
    }
    const { problems } = await watchCi(root, config, {
      onLog: log,
      wait: Boolean(flags.wait),
      issueIds: flags.issue as string[] | undefined,
    });
    const fixes = (await workspace.listFixes()).filter(
      (fix) => fix.pr && fix.ci && (!flags.issue || (flags.issue as string[]).includes(fix.issueId)),
    );
    if (!fixes.length) log('No open Bugpatrol PR has CI checks yet.');
    for (const fix of fixes) log(`  PR #${fix.pr!.number}  ${fix.ci!.state.padEnd(8)} ${fix.issueId}  ${fix.pr!.url}`);
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (command === 'publish') {
    if (!flags.dryRun && !config.agents.github.enabled) {
      throw new ConfigError(
        'GitHub is off. Set agents.github.enabled: true in .bugpatrol/bugpatrol.yml, ' +
          'or run `bugpatrol publish --dry-run` to write the reports to .bugpatrol/runs/publish/ only.',
      );
    }
    const outcomes = await runPublisher(root, config, {
      onLog: log,
      issueIds: flags.issue as string[] | undefined,
      dryRun: Boolean(flags.dryRun),
    });
    if (!flags.dryRun) await syncGitHub(root, config, { onLog: log });
    if (!outcomes.length) {
      log(
        `Nothing to publish. Bugpatrol opens a PR for each fix that has no PR yet, and a GitHub issue for each open ` +
          `issue at ${config.agents.github.issueMinSeverity} or worse that has no fix and no GitHub issue.`,
      );
      return;
    }
    for (const item of outcomes) {
      const kind =
        item.kind === 'pr'
          ? flags.dryRun
            ? 'PR draft'
            : 'PR'
          : item.kind === 'issue'
            ? flags.dryRun
              ? 'issue draft'
              : 'issue'
            : 'skipped';
      log(`  ${kind.padEnd(11)} ${item.issueId}  ${item.url ?? item.reason ?? ''}`);
    }
    const count = (kind: string) => outcomes.filter((item) => item.kind === kind).length;
    log(
      `${flags.dryRun ? 'Wrote' : 'Opened'} ${count('pr')} PR(s) and ${count('issue')} issue(s); skipped ${count('skipped')}.`,
    );
    return;
  }
  if (command === 'review') {
    let activeSession: AgentSession | undefined;
    const onSignal = () => {
      if (activeSession) activeSession.cancelled = true;
      log('Interrupt received; tearing down after the current operation.');
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      const review = await reviewPullRequest(root, config, flags.pr as number, {
        onLog: log,
        onSession: (session) => {
          activeSession = session;
        },
        dryRun: Boolean(flags.dryRun),
        force: Boolean(flags.force),
        allowFork: Boolean(flags.allowFork),
        maxSteps: flags.steps as number | undefined,
      });
      const count = (verdict: string) => review.findings.filter((finding) => finding.verdict === verdict).length;
      log(
        `PR #${review.pr.number}: ${count('introduced')} introduced, ${count('pre-existing')} already on ${review.baseRef}, ` +
          `${count('unclear')} not compared, ${count('not-a-bug')} not a bug.`,
      );
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
    return;
  }
  const vars = new Vars(config.app.secrets);
  if (command === 'judge') {
    // Every recent explorer session with candidates, not only the newest one:
    // the lesson pass after an explore is also an explorer session, with no
    // candidates. The judge skips the candidates that it already decided.
    const recent = (await workspace.listSessions())
      .filter((item) => item.role === 'explorer' && item.candidates > 0 && item.status !== 'running')
      .slice(0, 5)
      .map((item) => item.id);
    const ids = (flags.session as string[] | undefined) ?? recent;
    if (!ids.length)
      throw new ConfigError('No explorer session has candidates to judge. Run `bugpatrol explore` first.');
    const record = await workspace.startSession('judge');
    const session = new AgentSession(root, config, vars, record.id, 'judge', undefined, log);
    const pending = await pendingCandidates(session, ids);
    log(`Judging ${pending.length} new candidate(s) from ${ids.length} session(s): ${ids.join(', ')}`);
    await runJudge(session, createRuntime(config.agents.judge.use), { sessionIds: ids });
    // The session-end event already printed the summary.
    await logUsage(workspace, record.id, log);
    return;
  }
  if (command === 'fix') {
    if (!config.agents.fixer.enabled) {
      throw new ConfigError(
        'The fixer is off. Set agents.fixer.enabled: true in .bugpatrol/bugpatrol.yml. ' +
          'The fixer writes code, but only in its own git worktree under .bugpatrol/runs/worktrees/.',
      );
    }
    const proposals = await runFixCycle(root, config, { onLog: log, issueIds: flags.issue as string[] | undefined });
    if (!proposals.length) {
      log(
        `No fix to write. The fixer takes open issues at ${config.agents.fixer.minSeverity} or worse that have no fix yet, ` +
          `at most ${config.agents.fixer.maxPerCycle} for each run.`,
      );
      return;
    }
    for (const fix of proposals) log(`  ${fix.status.padEnd(9)} ${fix.issueId}  ${fix.branch}`);
    log(`${proposals.length} fix proposal(s). Run \`bugpatrol publish\` to open the PRs.`);
    return;
  }
  if (command === 'retest') {
    const ids = flags.issue as string[] | undefined;
    if (ids?.length !== 1) throw new ConfigError('retest needs --issue <id>');
    const issue = await workspace.readIssue(ids[0]!);
    const fix = issue?.fixId ? await workspace.readFix(issue.fixId) : undefined;
    if (!issue || !fix) throw new ConfigError(`No existing fix for ${ids[0]}`);
    const result = await retestFix(root, config, issue, fix, (fix.retests?.length ?? 0) + 1, { onLog: log });
    applyRetest(config, fix, result);
    await workspace.saveFix(fix);
    log(`Retest: ${result.outcome} — ${result.reason}`);
    return;
  }
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let driver: ReturnType<typeof createDriver> | undefined;
  let activeSession: AgentSession | undefined;
  const onSignal = () => {
    if (activeSession) {
      activeSession.cancelled = true;
    }
    driver?.interrupt?.();
    log('Interrupt received; tearing down after the current operation.');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    app = await startApp(config.app, { root, vars, emit: log });
    driver = createDriver(config, vars.resolve.bind(vars), (value) => vars.redact(value) as string);
    await driver.connect();
    if (driver.viewerUrl) {
      const directory = join(root, '.bugpatrol', 'runs');
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'desktop-viewer.json');
      await writeFile(path, JSON.stringify({ url: driver.viewerUrl }), { mode: 0o600 });
      await chmod(path, 0o600);
      log(`Private desktop viewer: ${driver.viewerUrl.split('#')[0]} (access link saved in ${path})`);
    }
    if (command === 'replay') {
      const record = await workspace.startSession('explorer');
      const session = new AgentSession(root, config, vars, record.id, 'explorer', driver, log);
      activeSession = session;
      const replay = await replayRoutine(session, String(flags.id));
      await workspace.endSession(record.id, {
        status: replay.ok ? 'finished' : 'failed',
        summary: replay.ok ? `Replayed ${flags.id}` : replay.error,
      });
      if (!replay.ok) throw new InfrastructureError(`Replay failed: ${replay.error}`);
      log(`Replayed ${flags.id}${replay.degraded ? ' (degraded)' : ''}`);
      return;
    }
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, vars, record.id, 'explorer', driver, log);
    activeSession = session;
    await withSessionLogs({ config, root, vars, onLog: log, workspace, session: record }, () =>
      runExplorer(session, createRuntime(config.agents.explorer.use), {
        goal: flags.goal as string | undefined,
        maxSteps: flags.steps as number | undefined,
      }),
    );
    // The session-end event already printed the summary.
    await logUsage(workspace, record.id, log);
    log('Next: run `bugpatrol judge` to file the real bugs as issues, or open `bugpatrol dashboard`.');
  } finally {
    try {
      try {
        await driver?.close();
      } finally {
        await app?.stop();
      }
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}
