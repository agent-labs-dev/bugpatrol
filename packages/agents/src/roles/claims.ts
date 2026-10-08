import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  type BugCheck,
  type Claim,
  type ClaimBench,
  type ClaimCheckRun,
  type ClaimEvidence,
  type ClaimFinding,
  type ClaimReplay,
  type ClaimVerdict,
  type PrReview,
  paths,
  type Routine,
  type RoutineStep,
} from '@bugpatrol/core';
import type { Driver, Observation } from '@bugpatrol/drivers';
import { judgeClaimVerdictsSystem } from '../prompts.js';
import { bugMisses, replaySteps } from '../replay.js';
import { reproRoutineId } from '../report.js';
import { createRuntime as makeRuntime } from '../runtime/index.js';
import { AgentSession } from '../session.js';
import type { Tool } from '../types.js';
import { Vars } from '../vars.js';
import { lessonsFor, type Workspace } from '../workspace.js';
import { benchWords, type Measured, overlaps } from './benches.js';
import { image } from './capture.js';
import { stepWords } from './fixer.js';
import type { ReviewContext } from './review.js';

const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const response = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const VERDICTS: ClaimVerdict[] = ['proven', 'not-proven', 'partly-proven', 'untested'];

/**
 * How Bugpatrol tests one claim. A `flow` is a claim routine that the
 * explorer saved on the pull request build, and Bugpatrol replays on both
 * builds. A `note` is a claim that the explorer checked, and whose flow
 * cannot be replayed. A `skip` is a claim that the explorer could not test.
 * A `repro` is the committed repro routine of an issue that the pull request
 * closes: its bug check gives the verdict, with no model.
 */
export type ClaimFlow =
  | { kind: 'flow'; did: string; saw: string; routine: Routine; path: string }
  | { kind: 'repro'; issue: number; did: string; routine: Routine; check: BugCheck; path: string }
  | { kind: 'note'; did: string; saw: string; reason: string }
  | { kind: 'skip'; reason: string };

/** The claim routines of a review, and their replays. A new test of the pull request starts it empty. */
const claimRoutinePath = (root: string, pr: number, claim: string) =>
  join(paths.reviewDir(root, pr), 'routines', `${claim}.json`);

/** The steps of a routine with the steps of each routine that it requires before them. */
async function chainSteps(workspace: Workspace, id: string | undefined, seen = new Set<string>()) {
  if (!id || seen.has(id)) return [];
  seen.add(id);
  const routine = await workspace.readRoutine(id);
  if (!routine) return [];
  const before: RoutineStep[] = [];
  for (const required of routine.requires ?? []) before.push(...(await chainSteps(workspace, required, seen)));
  return [...before, ...routine.steps];
}

const checkWords = (check: BugCheck) =>
  [
    check.shows && `shows "${check.shows}"`,
    check.lacks && `lacks "${check.lacks}"`,
    check.error && `logs an error with "${check.error}"`,
  ]
    .filter(Boolean)
    .join(' and ');

/**
 * A claim for each Bugpatrol issue that the pull request closes. The issue
 * body names its repro routine, and the checkout has the routine committed
 * (ADR 0006), so a fresh clone finds it. A routine that is gone, or that has
 * no bug check, gives a claim that cannot be tested, with the reason.
 */
export async function reproClaims(
  ctx: Pick<ReviewContext, 'root' | 'config' | 'workspace' | 'pr'>,
  first: number,
): Promise<{ claims: Claim[]; flows: Map<string, ClaimFlow> }> {
  const claims: Claim[] = [];
  const flows = new Map<string, ClaimFlow>();
  for (const issue of ctx.pr.issues) {
    const id = reproRoutineId(issue.body);
    if (!id) continue;
    const routine = await ctx.workspace.readRoutine(id);
    const claim: Claim = {
      id: `claim-${first + claims.length}`,
      text: `Fixes #${issue.number}: ${issue.title}`,
      platform: routine?.platform ?? ctx.config.app.platform,
      source: { kind: 'issue', number: issue.number },
      testable: Boolean(routine?.bug),
    };
    claims.push(claim);
    if (!routine) {
      claim.untestable = `Issue #${issue.number} names the repro routine ${id}, and this checkout has no such routine.`;
      continue;
    }
    if (!routine.bug) {
      claim.untestable = `The repro routine ${id} has no check that tells when the bug shows, so a replay cannot prove the fix.`;
      continue;
    }
    const steps = (await chainSteps(ctx.workspace, id)).map(({ at: _at, ...step }) => step as RoutineStep);
    flows.set(claim.id, {
      kind: 'repro',
      issue: issue.number,
      did: `Replayed the repro routine of #${issue.number}, and checked whether the last screen ${checkWords(routine.bug)}.`,
      routine: { ...routine, steps, requires: undefined },
      check: routine.bug,
      path: relative(ctx.root, paths.routine(ctx.root, id)),
    });
  }
  return { claims, flows };
}

/**
 * The explorer tools of the claim check. A claim routine holds every step
 * from the start of the app, also the steps of the routines it began with,
 * so it replays on a build that does not have those routines. It goes into
 * the run directory of the review, never into the routines of the patrol.
 */
export function claimTools(
  session: AgentSession,
  ctx: Pick<ReviewContext, 'root' | 'pr'>,
  claims: Claim[],
  flows: Map<string, ClaimFlow>,
): Tool[] {
  let started: string | undefined;
  const redact = (value: unknown) => session.vars.redact(String(value ?? '').trim()) as string;
  const known = (input: Record<string, unknown>) => claims.find((claim) => claim.id === input.claim);
  const unknown = () => ({
    ...response(`Unknown claim. The claims to test: ${claims.map((claim) => claim.id).join(', ')}.`),
    isError: true,
  });
  return [
    {
      name: 'start_claim',
      description:
        'Start the flow of one claim. Then open the page or run the routine where the flow starts, do the flow, ' +
        'and call save_claim.',
      inputSchema: schema({ claim: string }, ['claim']),
      async run(input) {
        const claim = known(input);
        if (!claim) return unknown();
        started = claim.id;
        session.anchor = { index: session.trail.length };
        return response(`Started ${claim.id}. Each step from now on is in its flow.`);
      },
    },
    {
      name: 'save_claim',
      description:
        'Save the flow since start_claim as the routine of the claim, when the screen shows the result. did: one ' +
        'sentence on what the flow does. saw: what this build shows.',
      inputSchema: schema({ claim: string, did: string, saw: string }, ['claim', 'did', 'saw']),
      async run(input) {
        const claim = known(input);
        if (!claim) return unknown();
        if (started !== claim.id)
          return { ...response(`Call start_claim for ${claim.id} first, before its flow.`), isError: true };
        const steps = [
          ...(await chainSteps(session.workspace, session.anchor.routineId)),
          ...session.trail.slice(session.anchor.index),
        ].map(({ at: _at, ...step }) => step as RoutineStep);
        const now = new Date().toISOString();
        const routine: Routine = {
          version: 1,
          id: claim.id,
          description: redact(input.did),
          platform: session.config.app.platform,
          steps,
          createdAt: now,
          updatedAt: now,
        };
        const file = claimRoutinePath(ctx.root, ctx.pr.number, claim.id);
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, `${JSON.stringify(routine, null, 2)}\n`);
        flows.set(claim.id, {
          kind: 'flow',
          did: routine.description,
          saw: redact(input.saw),
          routine,
          path: relative(ctx.root, file),
        });
        started = undefined;
        return response(`Saved the flow of ${claim.id} (${steps.length} steps).`);
      },
    },
    {
      name: 'note_claim',
      description:
        'Report a claim that you checked, and whose flow a replay cannot repeat (it hangs on timing, or on data ' +
        'that changes). did, saw, and reason: why it cannot be replayed.',
      inputSchema: schema({ claim: string, did: string, saw: string, reason: string }, [
        'claim',
        'did',
        'saw',
        'reason',
      ]),
      async run(input) {
        const claim = known(input);
        if (!claim) return unknown();
        flows.set(claim.id, {
          kind: 'note',
          did: redact(input.did),
          saw: redact(input.saw),
          reason: redact(input.reason),
        });
        return response(`Noted ${claim.id}.`);
      },
    },
    {
      name: 'skip_claim',
      description: 'Give up on a claim that you cannot test on this build, with the reason in one sentence.',
      inputSchema: schema({ claim: string, reason: string }, ['claim', 'reason']),
      async run(input) {
        const claim = known(input);
        if (!claim) return unknown();
        const reason = redact(input.reason);
        if (!reason) return { ...response('Say in reason why you cannot test the claim.'), isError: true };
        flows.set(claim.id, { kind: 'skip', reason });
        return response(`Skipped ${claim.id}.`);
      },
    },
  ];
}

/** A replay of each build, and `again`: the second replay on the pull request build. */
type ReplayPass = 'head' | 'base' | 'again';
const SESSION_OF = { head: 'headReplay', base: 'baseReplay', again: 'againReplay' } as const;
const WHERE_OF = {
  head: 'the pull request build',
  base: 'the base build',
  again: 'the pull request build a second time',
} as const;

/**
 * Replays each claim routine on one build, with no model, each from a new
 * driver, and keeps a screenshot before the first step and after each step.
 * A step that fails ends that replay. A driver that fails is an error.
 */
async function replayClaims(
  ctx: ReviewContext,
  review: PrReview,
  build: ReplayPass,
  routines: Map<string, Routine>,
  driver: Driver,
  vars: Vars,
  fresh: () => Promise<Driver>,
): Promise<Map<string, ClaimReplay>> {
  const { root, config, workspace, pr, opts } = ctx;
  const record = await workspace.startSession('explorer');
  review.sessions[SESSION_OF[build]] = record.id;
  const where = WHERE_OF[build];
  const replays = new Map<string, ClaimReplay>();
  let first = true;
  let status: 'finished' | 'failed' = 'finished';
  try {
    for (const [claim, routine] of routines) {
      const current = first ? driver : await fresh();
      first = false;
      const session = new AgentSession(root, config, vars, record.id, 'explorer', current, ctx.log);
      opts.onSession?.(session);
      await session.activity(`Replaying ${claim} on ${where} of PR #${pr.number}`, 0, 'no model');
      const dir = join(paths.reviewDir(root, pr.number), claim);
      await mkdir(dir, { recursive: true });
      const shots: string[] = [];
      const errors: string[] = [];
      let last: Observation | undefined;
      const shot = async () => {
        const file = join(dir, `${build}-${String(shots.length).padStart(2, '0')}.png`);
        last = await current.observe();
        errors.push(...last.consoleErrors, ...(last.networkErrors ?? []));
        await writeFile(file, last.screenshot);
        shots.push(relative(root, file));
      };
      await shot();
      const result = await replaySteps(session, routine.steps, { windowMs: opts.replayWindowMs, onStep: shot });
      // The bug shows only at the end of a full replay.
      const bug = routine.bug && result.ok ? { bug: !bugMisses(routine.bug, last!, errors).length } : {};
      replays.set(claim, { ok: result.ok, shots, failedStep: result.failedStep, error: result.error, ...bug });
      session.emit({
        kind: 'session-end',
        summary: `${claim} on ${where}: ${result.ok ? 'replayed' : `stopped at step ${(result.failedStep ?? 0) + 1}`}`,
      });
    }
  } catch (error) {
    status = 'failed';
    throw error;
  } finally {
    const summary = `Replayed ${replays.size} claim routine(s) on ${where} of PR #${pr.number}`;
    await workspace.endSession(record.id, { status, summary, steps: replays.size, costUsd: 0 });
    opts.onSession?.();
  }
  return replays;
}

type Tested = {
  claim: Claim;
  flow?: Extract<ClaimFlow, { kind: 'flow' | 'note' }>;
  head?: ClaimReplay;
  base?: ClaimReplay;
  bench?: ClaimBench;
};

const replayWords = (replay: ClaimReplay | undefined, steps: number) =>
  !replay
    ? 'not replayed.'
    : replay.ok
      ? `replayed all ${steps} step(s).`
      : `stopped at step ${(replay.failedStep ?? 0) + 1}: ${replay.error ?? 'no reason'}.`;

/**
 * The judge gives each tested claim a verdict. The evidence source comes
 * from how Bugpatrol tested the claim, never from the judge.
 */
async function judgeClaims(
  ctx: ReviewContext,
  review: PrReview,
  tested: Tested[],
): Promise<Map<string, { verdict: ClaimVerdict; reason: string; saw?: string }>> {
  const { root, config, workspace, pr, opts } = ctx;
  const vars = new Vars(config.app.secrets);
  const record = await workspace.startSession('judge');
  review.sessions.claimJudge = record.id;
  const session = new AgentSession(root, config, vars, record.id, 'judge', undefined, ctx.log);
  opts.onSession?.(session);
  const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.judge.use);
  const verdicts = new Map<string, { verdict: ClaimVerdict; reason: string; saw?: string }>();
  const find = (input: Record<string, unknown>) => tested.find((item) => item.claim.id === input.claim);
  const unknown = { ...response('Unknown claim id'), isError: true };
  const tools: Tool[] = [
    {
      name: 'view_claim',
      description:
        'View one claim: what Bugpatrol did, then the last screen of the pull request build and of the base build.',
      inputSchema: schema({ claim: string }, ['claim']),
      async run(input) {
        const item = find(input);
        if (!item) return unknown;
        const { claim, flow } = item;
        if (!flow) return response(`${claim.id}: ${claim.text}\n${benchWords(item.bench!)}`);
        const steps = flow.kind === 'flow' ? flow.routine.steps.length : 0;
        const head = await image(root, item.head?.shots.at(-1));
        const base = await image(root, item.base?.shots.at(-1));
        const how =
          flow.kind === 'flow'
            ? `Bugpatrol replayed the same ${steps} step(s) on both builds, with no model.`
            : `The explorer checked it on the pull request build only. No replay: ${flow.reason}`;
        return {
          content: [
            {
              type: 'text',
              text: `${claim.id}: ${claim.text}\nWhat Bugpatrol did: ${flow.did}\nThe explorer saw: ${flow.saw}\n${how}\nPull request build: ${replayWords(item.head, steps)}${head.length ? '' : ' No screenshot.'}`,
            },
            ...head,
            {
              type: 'text',
              text: `Base build: ${replayWords(item.base, steps)}${base.length ? '' : ' No screenshot.'}`,
            },
            ...base,
          ],
        };
      },
    },
    {
      name: 'verdict',
      description:
        'Give one claim its verdict and the reason. A not-proven verdict needs saw: what Bugpatrol saw, so the ' +
        'author knows what is still wrong.',
      inputSchema: schema({ claim: string, verdict: { type: 'string', enum: VERDICTS }, reason: string, saw: string }, [
        'claim',
        'verdict',
        'reason',
      ]),
      async run(input) {
        const item = find(input);
        if (!item) return unknown;
        if (!VERDICTS.includes(input.verdict as ClaimVerdict))
          return { ...response(`Use one verdict of ${VERDICTS.join(', ')}.`), isError: true };
        const reason = vars.redact(String(input.reason ?? '').trim()) as string;
        const saw = vars.redact(String(input.saw ?? '').trim()) as string;
        if (!reason) return { ...response('Give the reason in one or two sentences.'), isError: true };
        if (input.verdict === 'not-proven' && !saw)
          return { ...response('Say in saw what Bugpatrol saw that disproves the claim.'), isError: true };
        verdicts.set(item.claim.id, { verdict: input.verdict as ClaimVerdict, reason, ...(saw ? { saw } : {}) });
        const left = tested.filter((other) => !verdicts.has(other.claim.id)).map((other) => other.claim.id);
        return response(
          `${item.claim.id}: ${input.verdict}. ${left.length ? `Left: ${left.join(', ')}` : 'All decided.'}`,
        );
      },
    },
    {
      name: 'finish',
      description: 'Finish with one sentence, when every claim has a verdict.',
      inputSchema: schema({ summary: string }, ['summary']),
      async run(input) {
        return { ...response(String(input.summary ?? '')), done: true };
      },
    },
  ];
  const limits = config.agents.review;
  let cost = 0;
  let steps = 0;
  let status: 'finished' | 'failed' = 'finished';
  const start = `Judging ${tested.length} claim(s) of PR #${pr.number}`;
  await session.activity(start, 0, runtime.label);
  session.emit({ kind: 'session-start', summary: start });
  try {
    const outcome = await runtime.run(
      {
        role: 'judge',
        sessionId: record.id,
        system: judgeClaimVerdictsSystem(lessonsFor(await workspace.readMemory(), 'judge')),
        prompt: [
          `PULL REQUEST #${pr.number}: ${pr.title}`,
          pr.body.trim() || '(no description)',
          `DIFF (each line has its sign, then its line number in the new file)\n${pr.diff}`,
          `CLAIMS\n${tested.map((item) => `- ${item.claim.id}: ${item.claim.text}`).join('\n')}`,
        ].join('\n\n'),
        tools,
        maxSteps: Math.max(limits.maxSteps, tested.length * 2 + 4),
        budgetUsd: limits.budgetUsd,
        timeoutMs: limits.timeoutMs,
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
    const summary = `PR #${pr.number}: ${verdicts.size} of ${tested.length} claim(s) judged`;
    await workspace.endSession(record.id, { status, summary, steps, costUsd: cost });
    session.emit({ kind: 'session-end', summary });
    await session.idle(cost);
    opts.onSession?.();
  }
  return verdicts;
}

/** Starts one build and hands over a connected driver. An app that does not start throws. */
type StartBuild = <T>(
  name: 'head' | 'base',
  commit: string,
  run: (driver: Driver, vars: Vars, fresh: () => Promise<Driver>) => Promise<T>,
) => Promise<T>;

/**
 * Tests the testable claims: the explorer found their flows on the pull
 * request build, Bugpatrol replays each flow on both builds, and the judge
 * gives the verdicts. A claim that a benchmark measured is judged from its
 * numbers. `build` starts one build and hands over a connected driver; an
 * app that does not start throws, and gives no verdict.
 */
export async function checkClaims(
  ctx: ReviewContext,
  review: PrReview,
  claims: Claim[],
  flows: Map<string, ClaimFlow>,
  measured: Map<string, Measured>,
  build: StartBuild,
): Promise<ClaimFinding[]> {
  const { pr } = ctx;
  const routines = (keep: (claim: string) => boolean) =>
    new Map(
      [...flows]
        .filter(([claim, flow]) => (flow.kind === 'flow' || flow.kind === 'repro') && keep(claim))
        .map(([claim, flow]) => [claim, (flow as Replayed).routine]),
    );
  const head = routines(() => true);
  const headReplays = head.size
    ? await build('head', pr.head, (driver, vars, fresh) =>
        replayClaims(ctx, review, 'head', head, driver, vars, fresh),
      )
    : new Map<string, ClaimReplay>();
  // A flow that stops on the pull request build proves nothing on the base build.
  const base = routines((claim) => Boolean(headReplays.get(claim)?.ok));
  const baseReplays = base.size
    ? await build('base', pr.base, (driver, vars, fresh) =>
        replayClaims(ctx, review, 'base', base, driver, vars, fresh),
      )
    : new Map<string, ClaimReplay>();
  const tested: Tested[] = [];
  for (const claim of claims) {
    const flow = flows.get(claim.id);
    const bench = measured.get(claim.id);
    if (bench?.kind === 'bench') tested.push({ claim, bench: bench.bench });
    else if (flow?.kind === 'note' || (flow?.kind === 'flow' && headReplays.get(claim.id)?.ok))
      tested.push({ claim, flow, head: headReplays.get(claim.id), base: baseReplays.get(claim.id) });
  }
  const verdicts = tested.length ? await judgeClaims(ctx, review, tested) : new Map();
  return claims.map((claim): ClaimFinding => {
    const bench = measured.get(claim.id);
    if (bench?.kind === 'failed') return { claim, verdict: 'untested', reason: bench.reason };
    if (bench) {
      const judged = verdicts.get(claim.id);
      if (!judged) return { claim, verdict: 'untested', reason: 'The judge gave no verdict.', bench: bench.bench };
      // Inside the noise, a benchmark neither proves nor disproves a claim.
      const noise = overlaps(bench.bench) && judged.verdict !== 'untested';
      return {
        claim,
        verdict: noise ? 'partly-proven' : judged.verdict,
        ...(judged.verdict === 'untested' ? {} : { evidence: 'bench' as const }),
        reason: noise
          ? `${judged.reason} The spreads of the two builds overlap, so the difference may be noise.`
          : judged.reason,
        ...(judged.saw ? { saw: judged.saw } : {}),
        bench: bench.bench,
      };
    }
    const flow = flows.get(claim.id);
    if (!flow) return { claim, verdict: 'untested', reason: 'The explorer did not reach this claim.' };
    if (flow.kind === 'skip') return { claim, verdict: 'untested', reason: flow.reason };
    if (flow.kind === 'repro') return reproFinding(claim, flow, headReplays.get(claim.id), baseReplays.get(claim.id));
    const evidence: ClaimEvidence = flow.kind === 'flow' ? 'replay' : 'explored';
    const shown = {
      did: flow.did,
      ...(flow.kind === 'flow'
        ? {
            routine: flow.path,
            steps: flow.routine.steps.map(stepWords),
            head: headReplays.get(claim.id),
            base: baseReplays.get(claim.id),
          }
        : {}),
    };
    const replay = headReplays.get(claim.id);
    if (flow.kind === 'flow' && !replay?.ok)
      return {
        claim,
        verdict: 'untested',
        reason: `The replay on the pull request build stopped at step ${(replay?.failedStep ?? 0) + 1}: ${replay?.error ?? 'no reason'}.`,
        ...shown,
      };
    const judged = verdicts.get(claim.id);
    if (!judged) return { claim, verdict: 'untested', reason: 'The judge gave no verdict.', ...shown };
    return {
      claim,
      verdict: judged.verdict,
      ...(judged.verdict === 'untested' ? {} : { evidence }),
      reason: judged.reason,
      ...((judged.saw ?? flow.saw) ? { saw: judged.saw ?? flow.saw } : {}),
      ...shown,
    };
  });
}

type Replayed = Extract<ClaimFlow, { kind: 'flow' | 'repro' }>;

const stoppedWords = (replay: ClaimReplay | undefined) =>
  `stopped at step ${(replay?.failedStep ?? 0) + 1}: ${replay?.error ?? 'no reason'}.`;

/**
 * The verdict on an issue repro, from its bug check alone: the bug must show
 * on the base build and must not show on the pull request build. A repro
 * that does not show the bug on the base build is stale, and proves nothing.
 */
function reproFinding(
  claim: Claim,
  flow: Extract<ClaimFlow, { kind: 'repro' }>,
  head: ClaimReplay | undefined,
  base: ClaimReplay | undefined,
): ClaimFinding {
  const shown = { did: flow.did, routine: flow.path, steps: flow.routine.steps.map(stepWords), head, base };
  const untested = (reason: string): ClaimFinding => ({ claim, verdict: 'untested', reason, ...shown });
  if (!head?.ok) return untested(`The replay on the pull request build ${stoppedWords(head)}`);
  if (!base?.ok) return untested(`The repro no longer reproduces on the base build: the replay ${stoppedWords(base)}`);
  if (!base.bug) return untested('The repro no longer reproduces on the base build.');
  if (head.bug)
    return {
      claim,
      verdict: 'not-proven',
      evidence: 'replay',
      reason: `The bug of #${flow.issue} shows on the pull request build, as on the base build.`,
      saw: `The last screen of the repro still ${checkWords(flow.check)}.`,
      ...shown,
    };
  return {
    claim,
    verdict: 'proven',
    evidence: 'replay',
    reason: `The bug of #${flow.issue} shows on the base build, and not on the pull request build.`,
    ...shown,
  };
}

/** Only a replay and an assertion give the same result on each run (ADR 0001, ADR 0007). */
const DETERMINISTIC: ClaimEvidence[] = ['replay', 'assertion'];

const disproves = (finding: ClaimFinding) =>
  finding.verdict === 'not-proven' && DETERMINISTIC.includes(finding.evidence as ClaimEvidence);

/** The disproofs that may fail the check: each one gave the same result on a second replay. */
const blockingDisproofs = (findings: ClaimFinding[]) =>
  findings.filter((finding) => disproves(finding) && finding.again);

/** Why a second replay differs from the first, or undefined when both stopped at the same step on the same screen. */
async function difference(
  root: string,
  first: ClaimReplay | undefined,
  second: ClaimReplay,
): Promise<string | undefined> {
  const at = (replay: ClaimReplay | undefined) =>
    replay?.ok ? 'replayed all its steps' : `stopped at step ${(replay?.failedStep ?? 0) + 1}`;
  if (first?.ok !== second.ok || first?.failedStep !== second.failedStep)
    return `the first replay ${at(first)}, and the second ${at(second)}`;
  if (first?.bug !== second.bug) return 'the bug showed on one replay only';
  const last = async (replay: ClaimReplay) =>
    replay.shots.length ? await readFile(join(root, replay.shots.at(-1)!)) : Buffer.alloc(0);
  if (!(await last(first)).equals(await last(second)))
    return 'the second replay ended on a different screen than the first';
  return undefined;
}

/**
 * With blocking on, each disproof from a replay runs a second time on the
 * pull request build before it can fail the check. A second replay that
 * stops elsewhere, or ends on a different screen, makes the verdict untested.
 */
export async function replayDisproofs(
  ctx: ReviewContext,
  review: PrReview,
  findings: ClaimFinding[],
  flows: Map<string, ClaimFlow>,
  build: StartBuild,
): Promise<ClaimFinding[]> {
  const routines = new Map<string, Routine>();
  for (const finding of findings.filter(disproves)) {
    const flow = flows.get(finding.claim.id);
    if (flow?.kind === 'flow' || flow?.kind === 'repro') routines.set(finding.claim.id, flow.routine);
  }
  if (!routines.size) return findings;
  const again = await build('head', ctx.pr.head, (driver, vars, fresh) =>
    replayClaims(ctx, review, 'again', routines, driver, vars, fresh),
  );
  const out: ClaimFinding[] = [];
  for (const finding of findings) {
    const second = again.get(finding.claim.id);
    const differs = second && (await difference(ctx.root, finding.head, second));
    if (!second) out.push(finding);
    else if (!differs) out.push({ ...finding, again: second });
    else {
      const { evidence: _evidence, ...rest } = finding;
      out.push({ ...rest, verdict: 'untested', reason: `Flaky replay: ${differs}.`, again: second });
    }
  }
  return out;
}

/** The check run of the claim check: neutral unless a deterministic disproof exists. */
export function claimCheckRun(findings: ClaimFinding[], head: string): ClaimCheckRun {
  const failing = blockingDisproofs(findings);
  if (!failing.length)
    return {
      conclusion: 'neutral',
      title: 'No claim disproved by a replay',
      summary:
        'No replay or assertion disproved a claim. A verdict from the explorer and the judge, or from a benchmark, ' +
        'never fails this check. The review on the pull request has every verdict.',
    };
  const evidence = (finding: ClaimFinding) =>
    finding.evidence === 'replay'
      ? `the claim routine \`${finding.routine}\`, replayed twice on \`${head.slice(0, 7)}\` with no model, ` +
        'with the same result each time.'
      : `an exact assertion on \`${head.slice(0, 7)}\`, replayed twice with the same result.`;
  return {
    conclusion: 'failure',
    title: `${failing.length} claim${failing.length === 1 ? '' : 's'} disproved`,
    summary: [
      'Only a replay or an assertion that gives the same result twice can fail this check.',
      ...failing.map((finding) =>
        [
          `#### ${finding.claim.id}: ${finding.claim.text}`,
          `- Verdict: \`not-proven\`. ${finding.reason}`,
          ...(finding.saw ? [`- Bugpatrol saw: ${finding.saw}`] : []),
          `- Evidence: ${evidence(finding)}`,
        ].join('\n'),
      ),
    ].join('\n\n'),
  };
}
