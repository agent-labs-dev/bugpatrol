import {
  type Contract,
  caseKey,
  type RequestPolicy,
  type SweepCase,
  type SweepCaseId,
  specLacksErrors,
} from '@bugpatrol/contract';
import {
  type AssertionResult,
  assertionId,
  type Candidate,
  type CoverageCell,
  type CoverageFile,
  type EndpointKey,
  fingerprint,
  type HttpExchange,
  shortHash,
} from '@bugpatrol/core';
import { ApiDriver, type Observation } from '@bugpatrol/drivers';
import { addOccurrence } from './evaluate.js';
import { assertionWords, checkAssertions, confirmFailure, type ReplayOutcome, toAction } from './replay.js';
import type { AgentSession } from './session.js';

export type SweepBudget = { maxRequests: number; timeoutMs: number };

/** A failed case, or with `case: 'spec'`, the one finding of rule 4b. */
export type SweepFinding = {
  key: string;
  endpoint?: EndpointKey;
  case: SweepCaseId | 'spec';
  /** The assertion ids that failed, or `spec:no-errors`. */
  failed: string[];
  summary: string;
  status?: number;
  /** The failure came back on a second replay. Only such a failure blocks (ADR 0007). */
  repeats: boolean;
};

export type SweepResult = {
  /** The cells that this run wrote, the blocked ones too. */
  cells: CoverageCell[];
  findings: SweepFinding[];
  /** The cases that the request policy refuses. They send nothing. */
  skipped: { key: string; reason: string }[];
  requests: number;
  /** The cases of this pass that the next run starts with. */
  remaining: number;
  /** Why the run stopped before the end of its pass. */
  stopped?: 'budget' | 'timeout' | 'rate-limited' | 'interrupted';
};

/** What a sweep sends, in order, and what it does not send. Sends nothing. */
export type SweepPlan = {
  specDigest: string;
  order: SweepCase[];
  skipped: { key: string; reason: string }[];
  blocked: SweepCase[];
};

const keyOf = (item: SweepCase) => caseKey(item.endpoint.key, item.case);

/** The digest of the spec. A new digest starts a new pass. */
export const specDigest = (contract: Contract) => shortHash(JSON.stringify(contract.doc), 16);

/**
 * The order of the cases: the rest of the current pass first, so a run
 * resumes where the last one stopped. A new pass starts with the cells whose
 * `at` is oldest, and cells that never ran come first, so no endpoint
 * starves. A case that the policy refuses is skipped.
 */
export function planSweep(cases: SweepCase[], policy: RequestPolicy, coverage?: CoverageFile): SweepPlan {
  const digest = specDigest(policy.contract);
  const runnable = new Map<string, SweepCase>();
  const skipped: SweepPlan['skipped'] = [];
  const blocked: SweepCase[] = [];
  for (const item of cases) {
    if (item.blocked) {
      blocked.push(item);
      continue;
    }
    const refused = item.steps
      .map((step) => (step.kind === 'request' ? policy.check(step.method, step.url) : undefined))
      .find((verdict) => verdict && !verdict.ok);
    if (refused && !refused.ok) skipped.push({ key: keyOf(item), reason: refused.reason });
    else runnable.set(keyOf(item), item);
  }
  const cells = coverage?.cells ?? {};
  let next = coverage?.cursor?.specDigest === digest ? coverage.cursor.next.filter((key) => runnable.has(key)) : [];
  if (next.length) next.push(...[...runnable.keys()].filter((key) => !cells[key] && !next.includes(key)));
  else
    next = [...runnable.keys()]
      .map((key, index) => ({ key, index, at: cells[key]?.at ?? '' }))
      .sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index)
      .map((item) => item.key);
  return { specDigest: digest, order: next.map((key) => runnable.get(key)!), skipped, blocked };
}

/** One run of a case: the results of its checks, or why it could not run. */
type CaseRun = {
  sent: number;
  rateLimited?: true;
  blocked?: string;
  results: AssertionResult[];
  status?: number;
  /** The status of the checked request is declared for its endpoint. */
  declared?: boolean;
  /** The first checked request whose checks failed. */
  failing?: Observation;
  /** The last checked request that got an error status. */
  error?: HttpExchange;
};

/**
 * Runs the cases in the order of `planSweep` within the budget, with no
 * model (decision 4a). Each step goes through `toAction`, the api driver, and
 * `checkAssertions`. A failed case runs once more through `confirmFailure`:
 * only a failure that repeats can block. Each failure goes to the judge as a
 * candidate of this session, and a failure that does not repeat is a
 * non-blocking one. Coverage is written after each case, so an interrupted
 * run keeps its progress. A 429 stops the run, and its case stays pending.
 */
export async function runSweep(session: AgentSession, cases: SweepCase[], budget: SweepBudget): Promise<SweepResult> {
  const driver = session.driver;
  if (!(driver instanceof ApiDriver)) throw new Error('The sweep needs an api app');
  const { contract } = driver.policy;
  const { workspace } = session;
  const coverage: CoverageFile = (await workspace.readCoverage()) ?? { version: 1, cells: {} };
  const plan = planSweep(cases, driver.policy, coverage);
  await session.activity(`Sweep: ${plan.order.length} case(s) to run`);
  const now = () => new Date().toISOString();
  const written: CoverageCell[] = [];
  const write = (cell: CoverageCell) => {
    coverage.cells[caseKey(cell.endpoint, cell.case)] = cell;
    written.push(cell);
  };
  for (const item of plan.blocked)
    write({ endpoint: item.endpoint.key, case: item.case, ok: false, failed: [], blocked: item.blocked!, at: now() });

  const findings: SweepFinding[] = [];
  const next = plan.order.map(keyOf);
  const deadline = Date.now() + budget.timeoutMs;
  let requests = 0;
  let stopped: SweepResult['stopped'];
  let errorExchange: HttpExchange | undefined;
  const save = () => workspace.writeCoverage({ ...coverage, cursor: { specDigest: plan.specDigest, next } });

  for (const item of plan.order) {
    if (session.cancelled) stopped = 'interrupted';
    else if (Date.now() > deadline) stopped = 'timeout';
    else if (requests + item.steps.length > budget.maxRequests) stopped = 'budget';
    if (stopped) break;
    const key = keyOf(item);
    const first = await runCase(session, item, contract);
    requests += first.sent;
    if (first.rateLimited) {
      stopped = 'rate-limited';
      break;
    }
    const ids = failed(first);
    let differs: string | undefined;
    if (!first.blocked && ids.length) {
      const confirmed = await confirmFailure(new Map([[key, outcome(first)]]), async () => {
        const again = await runCase(session, item, contract);
        requests += again.sent;
        if (again.rateLimited) stopped = 'rate-limited';
        return new Map([[key, outcome(again)]]);
      });
      // The second run did not happen, so the case stays pending.
      if (stopped) break;
      differs = confirmed.get(key)?.differs;
    }
    errorExchange = first.error ?? errorExchange;
    const cell: CoverageCell = {
      endpoint: item.endpoint.key,
      case: item.case,
      ...(first.status === undefined ? {} : { status: first.status }),
      ok: !first.blocked && !ids.length,
      failed: ids,
      ...(first.blocked ? { blocked: first.blocked } : {}),
      at: now(),
    };
    write(cell);
    // A declared error status that a case got covers its own column of the matrix.
    if (!first.blocked && first.declared && first.status !== undefined && first.status >= 400)
      write({ ...cell, case: `declared:${first.status}` });
    next.splice(next.indexOf(key), 1);
    if (ids.length) {
      const repeats = differs === undefined;
      const words = first.results.filter((r) => !r.ok).map((r) => assertionWords(r, true));
      const finding: SweepFinding = {
        key,
        endpoint: item.endpoint.key,
        case: item.case,
        failed: ids,
        summary: `${key}: ${[...new Set(words)].join('; ')}`,
        ...(first.status === undefined ? {} : { status: first.status }),
        repeats,
      };
      findings.push(finding);
      const capture = first.failing?.capture;
      if (capture?.kind === 'http' && capture.exchange)
        await propose(session, finding, capture.exchange, item, {
          blocking: repeats,
          reason: repeats
            ? 'The sweep failure repeats on a second replay'
            : `The sweep failure does not repeat: ${differs}`,
        });
    }
    await save();
  }
  await save();

  // Rule 4b: one finding on the spec, not one for each route, also when connect.errors is set.
  if (specLacksErrors(contract)) {
    const finding: SweepFinding = {
      key: 'spec',
      case: 'spec',
      failed: ['spec:no-errors'],
      summary: 'The spec declares no error status other than 422 on at least 90% of its operations',
      repeats: false,
    };
    findings.push(finding);
    if (errorExchange)
      await propose(session, finding, errorExchange, undefined, {
        blocking: false,
        reason: 'The spec has no error responses, so each error status of the API is undeclared',
      });
  }
  return {
    cells: written,
    findings,
    skipped: plan.skipped,
    requests,
    remaining: next.length,
    ...(stopped ? { stopped } : {}),
  };
}

async function runCase(session: AgentSession, item: SweepCase, contract: Contract): Promise<CaseRun> {
  const driver = session.driver as ApiDriver;
  const run: CaseRun = { sent: 0, results: [] };
  for (const [index, step] of item.steps.entries()) {
    const result = await driver.act(toAction(step, session));
    if (result.error === 'rate-limited') return { ...run, rateLimited: true };
    run.sent += 1;
    if (!result.ok) return { ...run, blocked: `step ${index + 1} did not run: ${result.error ?? 'no response'}` };
    session.vars.capture(result.captures);
    if (!step.assert?.length) continue;
    const screen = await driver.observe();
    const response = screen.capture.kind === 'http' ? screen.capture.exchange?.response : undefined;
    // T8: Bugpatrol does not test an event stream, so a stream proves nothing.
    if (response?.stream) return { ...run, blocked: 'the response is an event stream, which the sweep does not test' };
    const results = checkAssertions(step.assert, screen, { raw: driver.lastRaw(), contract });
    run.results.push(...results);
    run.status = response?.status;
    run.declared = results.some((r) => r.assertion.kind === 'contract' && r.assertion.check === 'status' && r.ok);
    if (!run.failing && results.some((r) => !r.ok)) run.failing = screen;
    if (screen.capture.kind === 'http' && response && response.status >= 400) run.error = screen.capture.exchange;
  }
  return run;
}

const failed = (run: CaseRun) => [
  ...new Set(run.results.filter((result) => !result.ok).map((result) => assertionId(result.assertion))),
];

/** What `confirmFailure` compares: the checks and where the case stopped. */
const outcome = (run: CaseRun): ReplayOutcome => ({
  ok: !run.blocked,
  ...(run.blocked ? { failedStep: run.sent } : {}),
  assertions: run.results,
});

/**
 * A finding as a candidate for the judge. A fingerprint that the judge
 * dismissed stays quiet, and one that it filed adds an occurrence to its
 * issue, until the issue is fixed.
 */
async function propose(
  session: AgentSession,
  finding: SweepFinding,
  exchange: HttpExchange,
  item: SweepCase | undefined,
  route: { blocking: boolean; reason: string },
): Promise<void> {
  const print = fingerprint({
    screenId: finding.endpoint ?? 'spec',
    ruleId: `sweep:${finding.case}`,
    domNodeSignature: finding.failed.join(','),
  });
  const decided = (await session.workspace.readTriage()).fingerprints[print];
  if (decided?.decision === 'dismissed') return;
  if (decided?.decision === 'filed' && decided.issueId) {
    const issue = await session.workspace.readIssue(decided.issueId);
    if (issue && issue.status !== 'fixed') return addOccurrence(session, issue.id);
  }
  const candidate: Candidate = {
    id: `can_${shortHash(`${session.sessionId}:${finding.key}`)}`,
    sessionId: session.sessionId,
    source: 'sweep',
    ruleId: `sweep:${finding.case}`,
    fingerprint: print,
    summary: session.vars.redact(finding.summary) as string,
    severity: finding.failed.includes('contract:no-5xx') ? 'major' : 'minor',
    evidence: {
      capture: { kind: 'http', exchange: session.vars.redact(exchange) as HttpExchange },
      ...(item ? { steps: item.steps } : {}),
    },
    route: { to: 'judge', reason: route.reason },
    blocking: route.blocking,
    createdAt: new Date().toISOString(),
  };
  await session.workspace.appendCandidate(session.sessionId, candidate);
  session.emit({ kind: 'candidate', summary: candidate.summary });
}
