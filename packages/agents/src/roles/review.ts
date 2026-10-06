import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type BugpatrolConfig,
  type Candidate,
  ConfigError,
  InfrastructureError,
  instructionsPath,
  type PrReview,
  paths,
  type ReviewFinding,
  type ReviewVerdict,
  type Severity,
} from '@bugpatrol/core';
import { type Driver, createDriver as makeDriver } from '@bugpatrol/drivers';
import { defaultGh, ensureAssetsBranch, type Gh, ghReady, limitBody, resolveRepo, uploadImage } from '../github.js';
import { startApp } from '../lifecycle.js';
import { withSessionLogs } from '../logs.js';
import { activePatrolPid } from '../patrol.js';
import { explorerBaseSystem, explorerReviewPrompt, explorerReviewSystem, judgeReviewSystem } from '../prompts.js';
import { REVIEW_MARKER, renderReviewComment } from '../review-comment.js';
import { createRuntime as makeRuntime } from '../runtime/index.js';
import { AgentSession } from '../session.js';
import { explorerTools } from '../tools/explorer.js';
import type { Tool } from '../types.js';
import { Vars } from '../vars.js';
import { lessonsFor, Workspace } from '../workspace.js';
import { type CaptureTarget, captureTargets, image, targetLines } from './capture.js';
import { stopOnCancellation } from './explorer.js';
import { linkEnvFiles, stepWords } from './fixer.js';
import { overlayBugpatrol } from './overlay.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const response = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const short = (commit: string) => commit.slice(0, 7);

/** A lockfile diff is long and says nothing about a screen. */
const DIFF_PATHS = ['.', ':(exclude,glob)**/*.lock', ':(exclude,glob)**/*-lock.*', ':(exclude,glob)**/*.lockb'];
const DIFF_LIMIT = 40_000;

/**
 * The explorer on a pull request build acts and reports, and writes nothing
 * else. A screen, a routine or a lesson from a build that may never merge
 * must not enter the map that the patrol keeps for the main branch.
 */
const REVIEW_TOOLS = new Set([
  'look',
  'tap',
  'tap_point',
  'type',
  'press',
  'scroll',
  'back',
  'open',
  'wait',
  'request',
  'run_routine',
  'switch_window',
  'report_bug',
  'list_screens',
  'finish',
]);

export type ReviewOptions = {
  gh?: Gh;
  createDriver?: typeof makeDriver;
  createRuntime?: typeof makeRuntime;
  onLog?: (message: string) => void;
  onSession?: (session?: AgentSession) => void;
  /** Write the comment to `.bugpatrol/runs/reviews/`, and send nothing to GitHub. */
  dryRun?: boolean;
  /** Test the pull request again, also when the last review tested the same commit. */
  force?: boolean;
  /** Run the code of a pull request from a fork. It runs on this machine with the app's secrets. */
  allowFork?: boolean;
  maxSteps?: number;
};

type PullRequest = {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRef: string;
  head: string;
  /** The merge base: the base branch as it was when the pull request left it. */
  base: string;
  files: string[];
  diff: string;
};

type Context = {
  root: string;
  source: string;
  config: BugpatrolConfig;
  workspace: Workspace;
  repo: string;
  pr: PullRequest;
  opts: ReviewOptions;
  log: (message: string) => void;
};

async function loadPullRequest(
  gh: Gh,
  repo: string,
  source: string,
  number: number,
  allowFork: boolean,
): Promise<PullRequest> {
  const view = JSON.parse(
    await gh(
      ['pr', 'view', String(number), '--repo', repo, '--json', 'number,title,body,url,baseRefName,isCrossRepository'],
      { cwd: source },
    ),
  ) as { number: number; title: string; body: string; url: string; baseRefName: string; isCrossRepository: boolean };
  if (view.isCrossRepository && !allowFork)
    throw new ConfigError(
      `PR #${number} comes from a fork. A review runs its code on this machine, with the secrets of the app. ` +
        'Read the diff first. If you trust it, run the review again with --allow-fork.',
    );
  const headRef = `refs/bugpatrol/pr-${number}`;
  const baseRef = `refs/remotes/origin/${view.baseRefName}`;
  await git(
    source,
    'fetch',
    '-q',
    'origin',
    `+refs/pull/${number}/head:${headRef}`,
    `+refs/heads/${view.baseRefName}:${baseRef}`,
  );
  const head = await git(source, 'rev-parse', headRef);
  const base = await git(source, 'merge-base', head, baseRef);
  const files = (await git(source, 'diff', '--name-only', base, head)).split('\n').filter(Boolean);
  const diff = await git(source, 'diff', '--no-color', base, head, '--', ...DIFF_PATHS);
  return {
    number,
    url: view.url,
    title: view.title,
    body: view.body ?? '',
    baseRef: view.baseRefName,
    head,
    base,
    files,
    diff: diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n(cut: the diff is longer)` : diff,
  };
}

/**
 * Starts the app from one commit of the pull request, in its own worktree,
 * and removes the worktree after. The checkout is detached and has no work
 * of a person in it, so the forced removal loses nothing.
 */
async function withBuild<T>(
  ctx: Context,
  name: 'head' | 'base',
  commit: string,
  run: (driver: Driver, vars: Vars) => Promise<T>,
): Promise<T> {
  const { root, source, config } = ctx;
  const worktree = join(paths.worktrees(root), `review-${ctx.pr.number}-${name}`);
  const remove = async () => {
    try {
      await lstat(worktree);
    } catch {
      return;
    }
    await git(source, 'worktree', 'remove', '--force', worktree);
  };
  // A review that was killed leaves its worktree behind.
  await remove();
  await mkdir(paths.worktrees(root), { recursive: true });
  await git(source, 'worktree', 'add', '-q', '--detach', worktree, commit);
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let driver: Driver | undefined;
  let restore = async () => {};
  try {
    await linkEnvFiles(source, worktree);
    restore = await overlayBugpatrol(root, source, worktree);
    const prepare = config.agents.fixer.retest.prepare;
    if (prepare) {
      ctx.log(`Preparing the ${name} worktree: ${prepare}`);
      await exec('/bin/sh', ['-c', prepare], { cwd: worktree, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    }
    const vars = new Vars(config.app.secrets);
    app = await startApp(config.app, { root, vars, emit: ctx.log, source: worktree });
    driver = (ctx.opts.createDriver ?? makeDriver)(config, vars.resolve.bind(vars));
    await driver.connect();
    return await run(driver, vars);
  } finally {
    try {
      await driver?.close();
    } finally {
      try {
        await app?.stop();
      } finally {
        await restore();
        await remove();
      }
    }
  }
}

/** The explorer tests what the diff can affect on the pull request build. Each report is a candidate. */
async function exploreHead(ctx: Context, review: PrReview): Promise<Candidate[]> {
  const { root, config, workspace, pr, opts } = ctx;
  return withBuild(ctx, 'head', pr.head, async (driver, vars) => {
    const record = await workspace.startSession('explorer');
    review.sessions.explorer = record.id;
    const session = new AgentSession(root, config, vars, record.id, 'explorer', driver, ctx.log);
    opts.onSession?.(session);
    const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.explorer.use);
    const maxSteps = opts.maxSteps ?? config.agents.explorer.maxSteps;
    const guide = instructionsPath(root, config.app.instructions);
    await session.activity(`Reviewing PR #${pr.number}`, 0, runtime.label);
    session.emit({ kind: 'session-start', summary: `Reviewing PR #${pr.number}: ${pr.title}` });
    try {
      const outcome = await withSessionLogs(
        { config, root, vars, onLog: ctx.log, workspace, session: record },
        async () =>
          runtime.run(
            {
              role: 'explorer',
              sessionId: record.id,
              system: explorerReviewSystem(
                config.app.platform,
                guide ? await readFile(guide, 'utf8') : '',
                lessonsFor(await workspace.readMemory(), 'explorer'),
              ),
              prompt: explorerReviewPrompt({
                pr,
                screens: (await workspace.readAppMap())?.screens ?? [],
                routines: await workspace.listRoutines(),
                placeholders: vars.names(),
                maxSteps,
              }),
              tools: explorerTools(session, { replay: { save: false } })
                .filter((tool) => REVIEW_TOOLS.has(tool.name))
                .map((tool) => stopOnCancellation(session, tool)),
              maxSteps,
              budgetUsd: config.agents.explorer.budgetUsd,
              timeoutMs: config.agents.explorer.timeoutMs,
            },
            session.emit,
          ),
      );
      // "No problem found" from an explorer that did not run would be a false review.
      if (outcome.stop === 'error' || outcome.stop === 'timeout')
        throw new InfrastructureError(
          `The explorer did not finish (${outcome.stop}): ${outcome.error ?? outcome.summary ?? 'no result'}`,
        );
      const candidates = await workspace.readCandidates(record.id);
      review.costUsd += outcome.costUsd;
      review.tested =
        outcome.stop === 'done' && outcome.summary
          ? (vars.redact(outcome.summary.trim()) as string)
          : `The explorer stopped before it finished (${outcome.stop}), so it tested a part of the change only.`;
      await workspace.endSession(record.id, {
        steps: outcome.steps,
        costUsd: outcome.costUsd,
        summary: review.tested,
        candidates: candidates.length,
      });
      session.emit({ kind: 'session-end', summary: `${candidates.length} candidate(s) on PR #${pr.number}` });
      await session.idle(outcome.costUsd);
      return candidates;
    } catch (error) {
      await workspace.endSession(record.id, { status: 'failed', summary: String(error) });
      await session.idle();
      throw error;
    } finally {
      opts.onSession?.();
    }
  });
}

/**
 * Repeats the flow of each candidate on the merge base. A base build that
 * does not start is not the end of the review: the judge then decides from
 * the pull request build and the diff, and says what it could not compare.
 */
async function captureBase(ctx: Context, review: PrReview, candidates: Candidate[]): Promise<CaptureTarget[]> {
  const { root, config, workspace, pr, opts } = ctx;
  const targets: CaptureTarget[] = candidates.map((candidate) => ({
    shot: {
      screenId: candidate.screenId,
      routineId: candidate.evidence.routineId,
      before: candidate.evidence.screenshot,
    },
    steps: candidate.evidence.steps ?? [],
  }));
  try {
    await withBuild(ctx, 'base', pr.base, async (driver, vars) => {
      const record = await workspace.startSession('explorer');
      review.sessions.base = record.id;
      const session = new AgentSession(root, config, vars, record.id, 'explorer', driver, ctx.log);
      opts.onSession?.(session);
      const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.explorer.use);
      const guide = instructionsPath(root, config.app.instructions);
      const summary = `Repeating ${targets.length} flow(s) on the base of PR #${pr.number}`;
      await session.activity(summary, 0, runtime.label);
      session.emit({ kind: 'session-start', summary });
      let cost = 0;
      let steps = 0;
      try {
        const outcome = await captureTargets(session, runtime, targets, {
          replay: { save: false },
          system: explorerBaseSystem(
            config.app.platform,
            guide ? await readFile(guide, 'utf8') : '',
            lessonsFor(await workspace.readMemory(), 'explorer'),
          ),
          prompt: `Pull request #${pr.number}: ${pr.title}\nFindings:\n${candidates
            .map((candidate, index) => `${index + 1}. ${candidate.summary}`)
            .join('\n')}\nTargets:\n${targetLines(targets)}`,
        });
        cost = outcome.costUsd;
        steps = outcome.steps;
      } finally {
        review.costUsd += cost;
        const reached = targets.filter((target) => target.shot.reached).length;
        const done = `Reached ${reached} of ${targets.length} flow(s) on the base of PR #${pr.number}`;
        await workspace.endSession(record.id, { summary: done, steps, costUsd: cost });
        session.emit({ kind: 'session-end', summary: done });
        await session.idle(cost);
        opts.onSession?.();
      }
    });
  } catch (error) {
    const reason = `The base build did not run: ${String(error).split('\n')[0]}`;
    ctx.log(reason);
    for (const target of targets)
      if (!target.shot.after) {
        target.shot.reached = false;
        target.shot.note = reason;
      }
  }
  return targets;
}

/** The judge compares the two builds and gives each candidate a verdict. */
async function judgeFindings(
  ctx: Context,
  review: PrReview,
  candidates: Candidate[],
  targets: CaptureTarget[],
): Promise<ReviewFinding[]> {
  const { root, config, workspace, pr, opts } = ctx;
  const vars = new Vars(config.app.secrets);
  const record = await workspace.startSession('judge');
  review.sessions.judge = record.id;
  const session = new AgentSession(root, config, vars, record.id, 'judge', undefined, ctx.log);
  opts.onSession?.(session);
  const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.judge.use);
  const baseNote = (index: number) => {
    const shot = targets[index]!.shot;
    return shot.reached ? (shot.note ?? '') : `Not reached on the base build. ${shot.note ?? ''}`.trim();
  };
  const verdicts = new Map<string, Pick<ReviewFinding, 'verdict' | 'title' | 'severity' | 'reason'>>();
  const tools: Tool[] = [
    {
      name: 'view_finding',
      description: 'View one finding: the report, then the pull request build and the base build screenshots.',
      inputSchema: schema({ id: string }, ['id']),
      async run(input) {
        const index = candidates.findIndex((candidate) => candidate.id === input.id);
        const candidate = candidates[index];
        if (!candidate) return { ...response('Unknown finding id'), isError: true };
        const head = await image(root, candidate.evidence.screenshot);
        const base = await image(root, targets[index]!.shot.after);
        return {
          content: [
            {
              type: 'text',
              text: `${candidate.id} on ${candidate.screenId ?? 'unknown screen'}: ${candidate.summary}\n${candidate.detail ?? ''}\nPull request build${head.length ? ':' : ': no screenshot.'}`,
            },
            ...head,
            { type: 'text', text: `Base build${base.length ? ':' : ': no screenshot.'} ${baseNote(index)}` },
            ...base,
          ],
        };
      },
    },
    {
      name: 'classify',
      description: 'Give one finding its verdict, with a title of at most 80 characters and a reason.',
      inputSchema: schema(
        {
          id: string,
          verdict: { type: 'string', enum: ['introduced', 'pre-existing', 'not-a-bug', 'unclear'] },
          title: string,
          severity: { type: 'string', enum: ['cosmetic', 'minor', 'major', 'critical'] },
          reason: string,
        },
        ['id', 'verdict', 'title', 'severity', 'reason'],
      ),
      async run(input) {
        if (!candidates.some((candidate) => candidate.id === input.id))
          return { ...response('Unknown finding id'), isError: true };
        const title = String(input.title ?? '').trim();
        if (title.length > 80)
          return {
            ...response(`The title has ${title.length} characters; the limit is 80. Write a shorter title.`),
            isError: true,
          };
        verdicts.set(String(input.id), {
          verdict: input.verdict as ReviewVerdict,
          title,
          severity: input.severity as Severity,
          reason: String(input.reason ?? '').trim(),
        });
        const left = candidates.filter((candidate) => !verdicts.has(candidate.id)).map((candidate) => candidate.id);
        return response(`${input.id}: ${input.verdict}. ${left.length ? `Left: ${left.join(', ')}` : 'All decided.'}`);
      },
    },
    {
      name: 'finish',
      description: 'Finish with one sentence, when every finding has a verdict.',
      inputSchema: schema({ summary: string }, ['summary']),
      async run(input) {
        return { ...response(String(input.summary ?? '')), done: true };
      },
    },
  ];
  let cost = 0;
  let steps = 0;
  let status: 'finished' | 'failed' = 'finished';
  await session.activity(`Judging ${candidates.length} finding(s) on PR #${pr.number}`, 0, runtime.label);
  session.emit({ kind: 'session-start', summary: `Judging ${candidates.length} finding(s) on PR #${pr.number}` });
  try {
    const outcome = await runtime.run(
      {
        role: 'judge',
        sessionId: record.id,
        system: judgeReviewSystem(lessonsFor(await workspace.readMemory(), 'judge')),
        prompt: `PULL REQUEST #${pr.number}: ${pr.title}\n${pr.body.trim() || '(no description)'}\n\nDIFF\n${pr.diff}\n\nFINDINGS\n${candidates
          .map(
            (candidate, index) =>
              `- ${candidate.id} [${candidate.severity}] on ${candidate.screenId ?? 'unknown screen'}: ${candidate.summary}. ` +
              `Base build: ${targets[index]!.shot.reached ? 'reached' : 'not reached'}.`,
          )
          .join('\n')}`,
        tools,
        maxSteps: Math.max(config.agents.judge.maxSteps, candidates.length * 2 + 10),
        budgetUsd: config.agents.judge.budgetUsd,
        timeoutMs: config.agents.judge.timeoutMs,
      },
      session.emit,
    );
    cost = outcome.costUsd;
    steps = outcome.steps;
  } catch (error) {
    status = 'failed';
    throw error;
  } finally {
    review.costUsd += cost;
    const count = [...verdicts.values()].filter((item) => item.verdict === 'introduced').length;
    const summary = `PR #${pr.number}: ${count} introduced problem(s) in ${candidates.length} finding(s)`;
    await workspace.endSession(record.id, { status, summary, steps, costUsd: cost });
    session.emit({ kind: 'session-end', summary });
    await session.idle(cost);
    opts.onSession?.();
  }
  return candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    screenId: candidate.screenId,
    // A finding that the judge did not reach is never shown as the pull request's fault.
    ...(verdicts.get(candidate.id) ?? {
      verdict: 'unclear' as const,
      title: candidate.summary.slice(0, 80),
      severity: candidate.severity,
      reason: 'The judge gave no verdict.',
    }),
    steps: [
      ...(candidate.evidence.routineId ? [`Run the routine ${candidate.evidence.routineId}`] : []),
      ...(candidate.evidence.steps ?? []).map(stepWords),
    ],
    head: candidate.evidence.screenshot,
    base: targets[index]!.shot.after,
    baseNote: baseNote(index) || undefined,
  }));
}

/**
 * A later `bugpatrol judge` reads the candidates of each recent explorer
 * session. It must not file a problem that exists only on this pull request
 * as an issue of the main branch, so the review decides those candidates
 * here. A pre-existing problem stays open for that judge: the base build has it.
 */
async function settleCandidates(ctx: Context, sessionId: string, findings: ReviewFinding[]): Promise<void> {
  const lines = findings
    .filter((finding) => finding.verdict !== 'pre-existing')
    .map((finding) =>
      JSON.stringify({
        candidateId: finding.candidateId,
        decision: 'dismiss',
        reason: `Review of PR #${ctx.pr.number}: ${finding.verdict}`,
        at: new Date().toISOString(),
      }),
    );
  if (lines.length)
    await appendFile(join(paths.session(ctx.root, sessionId), 'decisions.jsonl'), `${lines.join('\n')}\n`);
}

async function runReview(ctx: Context): Promise<PrReview> {
  const { workspace, pr } = ctx;
  const review: PrReview = {
    version: 1,
    pr: { number: pr.number, url: pr.url, title: pr.title },
    head: pr.head,
    base: pr.base,
    baseRef: pr.baseRef,
    status: 'running',
    startedAt: new Date().toISOString(),
    sessions: {},
    findings: [],
    costUsd: 0,
  };
  await workspace.saveReview(review);
  try {
    if (!pr.files.length) {
      review.tested = `The pull request changes no file against \`${pr.baseRef}\`.`;
    } else {
      const candidates = await exploreHead(ctx, review);
      // With no report there is nothing to compare, so the base build does not start.
      if (candidates.length) {
        const targets = await captureBase(ctx, review, candidates);
        review.findings = await judgeFindings(ctx, review, candidates, targets);
        await settleCandidates(ctx, review.sessions.explorer!, review.findings);
      }
    }
    review.status = 'finished';
  } catch (error) {
    review.status = 'failed';
    review.error = String(error);
    throw error;
  } finally {
    review.endedAt = new Date().toISOString();
    await workspace.saveReview(review);
  }
  return review;
}

/** One comment for each pull request: a new review edits the comment of the last one. */
async function publishComment(ctx: Context, gh: Gh, review: PrReview): Promise<void> {
  const { root, config, repo, pr } = ctx;
  const redact = (text: string) => new Vars(config.app.secrets).redact(text) as string;
  if (ctx.opts.dryRun) {
    const file = paths.review(root, pr.number).replace(/\.json$/, '.md');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, redact(renderReviewComment(review, (path) => resolve(root, path))));
    ctx.log(`Wrote the review of PR #${pr.number} to ${file}. Nothing went to GitHub.`);
    return;
  }
  const branch = config.agents.github.assetsBranch;
  const urls = new Map<string, string>();
  const shown = review.findings
    .filter((finding) => finding.verdict === 'introduced')
    .flatMap((finding) => [finding.head, finding.base])
    .filter((path): path is string => Boolean(path));
  if (shown.length) await ensureAssetsBranch(gh, repo, branch);
  for (const path of new Set(shown)) {
    try {
      urls.set(path, await uploadImage(gh, repo, branch, resolve(root, path), `pr-${pr.number}`));
    } catch (error) {
      ctx.log(`Could not upload ${path}: ${String(error).split('\n')[0]}`);
    }
  }
  const body = JSON.stringify({ body: limitBody(redact(renderReviewComment(review, (path) => urls.get(path)))) });
  const comments = `repos/${repo}/issues/${pr.number}/comments`;
  const [existing] = (
    await gh(['api', '--paginate', comments, '--jq', `.[] | select(.body | contains("${REVIEW_MARKER}")) | .id`])
  )
    .split('\n')
    .filter(Boolean);
  const posted = JSON.parse(
    existing
      ? await gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing}`, '--input', '-'], { input: body })
      : await gh(['api', '-X', 'POST', comments, '--input', '-'], { input: body }),
  ) as { html_url: string };
  review.comment = { url: posted.html_url, at: new Date().toISOString() };
  await ctx.workspace.saveReview(review);
  ctx.log(`${existing ? 'Updated' : 'Posted'} the review of PR #${pr.number}: ${posted.html_url}`);
}

/**
 * A differential review of one pull request: the explorer tests what the
 * diff can affect on the pull request build, repeats each reported flow on
 * the merge base, and the judge keeps only what the pull request introduces.
 * The review comments and never blocks a merge (ADR 0005, section 6).
 */
export async function reviewPullRequest(
  root: string,
  config: BugpatrolConfig,
  number: number,
  opts: ReviewOptions = {},
): Promise<PrReview> {
  if (!opts.dryRun && !config.agents.github.enabled)
    throw new ConfigError(
      'GitHub is off. Set agents.github.enabled: true in .bugpatrol/bugpatrol.yml, ' +
        'or run `bugpatrol review <pr> --dry-run` to write the comment to .bugpatrol/runs/reviews/ only.',
    );
  const gh = opts.gh ?? defaultGh;
  const ready = await ghReady(gh);
  if (!ready.ok) throw new ConfigError(ready.reason.replace('GitHub publish skipped', 'Review stopped'));
  const workspace = new Workspace(root);
  const patrol = activePatrolPid((await workspace.readAgents()).patrol);
  if (patrol)
    throw new ConfigError(
      `A patrol runs (pid ${patrol}), and it uses the app. Stop the patrol, or review when it waits for a new commit.`,
    );
  const source = resolve(root, config.app.source);
  const log = opts.onLog ?? (() => {});
  const { repo } = await resolveRepo(gh, config, source);
  const pr = await loadPullRequest(gh, repo, source, number, Boolean(opts.allowFork));
  const ctx: Context = { root, source, config, workspace, repo, pr, opts, log };
  const last = await workspace.readReview(number);
  let review: PrReview;
  if (last?.status === 'finished' && last.head === pr.head && !opts.force) {
    log(`PR #${number} has a review of ${short(pr.head)}: published it again. Use --force to test the commit again.`);
    review = last;
  } else {
    log(`Reviewing PR #${number} at ${short(pr.head)} against ${short(pr.base)} on ${pr.baseRef}.`);
    review = await runReview(ctx);
  }
  await publishComment(ctx, gh, review);
  return review;
}
