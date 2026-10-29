import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Candidate, fingerprint, type Issue, paths, type RoutineStep, shortHash } from '@bugpatrol/core';
import { diff } from '@bugpatrol/diff';
import type { Observation } from '@bugpatrol/drivers';
import { evaluateAll, type InvariantViolation, RULES, type ScreenSnapshot } from '@bugpatrol/invariants';
import { closeOnGitHub } from './github.js';
import type { AgentSession } from './session.js';

const NATIVE_DISABLED = [
  'layout/overflow',
  'layout/horizontal-scroll',
  'rendering/unstyled-content',
  'rendering/broken-imagery',
  'usability/contrast',
  'layout/occlusion',
];

type Entry = {
  source: Candidate['source'];
  ruleId: string;
  summary: string;
  detail?: string;
  severity: Candidate['severity'];
  /** Part of the fingerprint: the elements, or the changed region. */
  signature: string;
  region?: { x: number; y: number; width: number; height: number };
};

type Baseline = { png: string; snapshotFile: string; snapshot?: ScreenSnapshot };

const SEVERITY_RANK: Record<Candidate['severity'], number> = { cosmetic: 0, minor: 1, major: 2, critical: 3 };

/**
 * Turns one capture into the candidates a judge should see, and no more.
 *
 * - The first capture of a screen becomes its baseline. The absolute checks
 *   still run on it, so a problem that is there from the start shows once.
 * - Violations of one rule on one screen become ONE candidate that lists the
 *   elements. Eleven low-contrast labels are one decision, not eleven.
 * - A fingerprint the judge already decided (triage.json) is not raised
 *   again; a filed one adds an occurrence to its issue instead.
 */
export async function evaluateScreen(
  session: AgentSession,
  input: { screenId: string; observation: Observation; snapshot: ScreenSnapshot },
): Promise<Candidate[]> {
  const { screenId, observation, snapshot } = input;
  // An API exchange has no pixels and no DOM: its checks are the contract (ADR 0008).
  if (observation.capture.kind === 'http') return [];
  const screenshot =
    session.lastObservation === observation && session.lastCapture
      ? session.lastCapture
      : await session.capture(observation, screenId);
  if (!screenshot) return [];
  await writeFile(
    join(paths.session(session.root, session.sessionId), `${screenId}.snapshot.json`),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );

  const baseline = await readBaseline(session, screenId);
  const firstSight = !baseline.snapshot;
  if (firstSight) await saveBaseline(session, baseline, screenshot, snapshot);

  const native = observation.platform === 'ios' || observation.platform === 'android';
  const enabled = new Set<string>(session.config.agents.checks);
  const violations = evaluateAll(snapshot, {
    baseline: baseline.snapshot,
    disabled: RULES.map((rule) => rule.id).filter((id) => !enabled.has(id) || (native && NATIVE_DISABLED.includes(id))),
  });
  const entries = groupViolations(violations);

  let diffPath: string | undefined;
  let visual: Awaited<ReturnType<typeof diff>>['primary'] | undefined;
  if (!firstSight && enabled.has('pixel-diff')) {
    diffPath = join(paths.session(session.root, session.sessionId), `${screenId}-diff.png`);
    const comparison = await diff({
      baselinePath: baseline.png,
      actualPath: join(session.root, screenshot),
      diffOutPath: diffPath,
      threshold: 0.1,
      masks: observation.volatileRegions.map((region) => ({ ...region, selector: region.reason })),
    });
    visual = comparison.primary;
    const pixelEntry = visualEntry(visual);
    if (pixelEntry) entries.push(pixelEntry);
    else diffPath = undefined;
  }

  const fresh = await dropDecided(session, screenId, entries);
  await closeAbsentChecks(session, screenId, new Set(entries.map((entry) => entryFingerprint(screenId, entry))));
  if (fresh.length === 0) return [];

  const routeResult = { to: 'judge' as const, reason: 'Automatic check' };
  const candidates: Candidate[] = [];
  for (const entry of fresh) {
    const candidate = toCandidate(session, screenId, entry, {
      screenshot,
      baseline: firstSight ? undefined : baseline.png,
      diff: entry.source === 'pixel-diff' ? diffPath : undefined,
      route: routeResult,
    });
    await session.workspace.appendCandidate(session.sessionId, candidate);
    session.emit({ kind: 'candidate', summary: candidate.summary, screenId, screenshot });
    candidates.push(candidate);
  }
  return candidates;
}

async function readBaseline(session: AgentSession, screenId: string): Promise<Baseline> {
  const png = paths.agentBaseline(session.root, screenId);
  const snapshotFile = paths.agentBaselineSnapshot(session.root, screenId);
  try {
    await readFile(png);
    const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8')) as ScreenSnapshot;
    return { png, snapshotFile, snapshot };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { png, snapshotFile };
  }
}

async function saveBaseline(
  session: AgentSession,
  baseline: Baseline,
  screenshot: string,
  snapshot: ScreenSnapshot,
): Promise<void> {
  await mkdir(paths.agentBaselines(session.root), { recursive: true });
  await copyFile(join(session.root, screenshot), baseline.png);
  await writeFile(baseline.snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** One entry per rule; the elements go in the detail and the fingerprint. */
export function groupViolations(violations: InvariantViolation[]): Entry[] {
  const byRule = new Map<string, InvariantViolation[]>();
  for (const violation of violations) {
    const group = byRule.get(violation.ruleId) ?? [];
    group.push(violation);
    byRule.set(violation.ruleId, group);
  }

  const entries: Entry[] = [];
  for (const [ruleId, group] of byRule) {
    const worst = group.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a));
    const selectors = [...new Set(group.map((item) => item.selector ?? ''))].sort();
    const summary =
      group.length === 1 ? worst.message : `${group.length} elements break ${ruleId}. For example: ${worst.message}`;
    entries.push({
      source: 'invariant',
      ruleId,
      summary,
      detail: group
        .slice(0, 8)
        .map((item) => `- ${item.message}`)
        .join('\n'),
      severity: worst.severity,
      signature: selectors.join('|'),
      region: worst.region,
    });
  }
  return entries;
}

/** This is not the merge gate, so small changes stay quiet (ADR 0005). */
function visualEntry(visual: Awaited<ReturnType<typeof diff>>['primary']): Entry | undefined {
  const changed = Boolean(visual.dimensionMismatch) || visual.changedFraction > 0.005;
  if (!changed) return undefined;
  return {
    source: 'pixel-diff',
    ruleId: 'pixel-diff',
    summary: visual.dimensionMismatch
      ? 'The screen size changed'
      : `${(visual.changedFraction * 100).toFixed(1)}% of the screen changed`,
    severity: 'minor',
    signature: 'screen',
    region: visual.regions[0],
  };
}

function entryFingerprint(screenId: string, entry: Entry): string {
  return fingerprint({ screenId, ruleId: entry.ruleId, domNodeSignature: entry.signature });
}

/**
 * Drops what the judge already decided. A filed fingerprint bumps its issue
 * once per session, so the dashboard's "x3" means three sessions saw it.
 */
async function dropDecided(session: AgentSession, screenId: string, entries: Entry[]): Promise<Entry[]> {
  const triage = await session.workspace.readTriage();
  const fresh: Entry[] = [];
  for (const entry of entries) {
    const decided = triage.fingerprints[entryFingerprint(screenId, entry)];
    if (!decided || entry.source === 'pixel-diff') {
      fresh.push(entry);
      continue;
    }
    if (decided.decision === 'filed' && decided.issueId) {
      const issue = await session.workspace.readIssue(decided.issueId);
      if (issue?.status === 'fixed') fresh.push(entry);
      else await addOccurrence(session, decided.issueId);
    }
  }
  return fresh;
}

export async function addOccurrence(session: AgentSession, issueId: string): Promise<void> {
  if (session.seenIssues.has(issueId)) return;
  session.seenIssues.add(issueId);
  const issue = await session.workspace.readIssue(issueId);
  if (!issue || issue.status === 'dismissed' || issue.status === 'fixed') return;
  await session.workspace.saveIssue({
    ...issue,
    occurrences: issue.occurrences + 1,
    notSeen: 0,
    lastSeenAt: new Date().toISOString(),
  });
  session.emit({ kind: 'issue', summary: `Seen again: ${issue.title}` });
}

/** Three clean visits close an issue caused only by automatic checks on this screen. */
export async function closeAbsentChecks(
  session: AgentSession,
  screenId: string,
  fired: Set<string>,
): Promise<string[]> {
  const closed: string[] = [];
  const enabled = new Set<string>(session.config.agents.checks);
  const ids = new Set(
    (await session.workspace.listIssues())
      .filter(
        (issue) =>
          issue.screenId === screenId &&
          ['new', 'filed', 'fixing', 'fix-proposed', 'waits-for-deploy'].includes(issue.status),
      )
      .map((issue) => issue.id),
  );
  const sources = new Map<string, Candidate>();
  for (const record of await session.workspace.listSessions(Infinity)) {
    for (const candidate of await session.workspace.readCandidates(record.id)) sources.set(candidate.id, candidate);
  }
  for (const id of ids) {
    const issue = await session.workspace.readIssue(id);
    if (!issue?.candidateIds.length) continue;
    const candidates = issue.candidateIds.map((candidateId) => sources.get(candidateId));
    if (
      candidates.some((candidate) => !candidate || candidate.source === 'explorer' || candidate.screenId !== screenId)
    )
      continue;
    // A check that is off now cannot see the problem, so its absence proves nothing.
    if (candidates.some((candidate) => !enabled.has(candidate!.ruleId ?? candidate!.source))) continue;
    if (candidates.some((candidate) => fired.has(candidate!.fingerprint))) {
      if (issue.notSeen) await session.workspace.saveIssue({ ...issue, notSeen: 0 });
      continue;
    }
    const notSeen = (issue.notSeen ?? 0) + 1;
    const fixed = notSeen >= 3;
    const updated: Issue = {
      ...issue,
      notSeen,
      status: fixed ? 'fixed' : issue.status,
      closedBy: fixed
        ? {
            by: 'Bugpatrol',
            reason: `The automatic checks did not find it on ${screenId} in 3 visits.`,
            at: new Date().toISOString(),
          }
        : issue.closedBy,
    };
    await session.workspace.saveIssue(updated);
    if (fixed) {
      await closeOnGitHub(session.root, session.config, updated);
      closed.push(issue.id);
      session.emit({ kind: 'issue', summary: `Fixed: ${issue.title}` });
    }
  }
  return closed;
}

function toCandidate(
  session: AgentSession,
  screenId: string,
  entry: Entry,
  extra: { screenshot: string; baseline?: string; diff?: string; route: NonNullable<Candidate['route']> },
): Candidate {
  const fp = entryFingerprint(screenId, entry);
  return {
    id: `can_${shortHash(`${session.sessionId}:${fp}:${randomUUID()}`)}`,
    sessionId: session.sessionId,
    screenId,
    source: entry.source,
    ruleId: entry.ruleId,
    fingerprint: fp,
    summary: entry.summary,
    detail: entry.detail,
    severity: entry.severity,
    evidence: {
      capture: {
        kind: 'image',
        screenshot: extra.screenshot,
        ...(extra.baseline ? { baseline: extra.baseline } : {}),
        ...(extra.diff ? { diff: extra.diff } : {}),
      },
      routineId: session.anchor.routineId,
      steps: session.trail.slice(session.anchor.index).map(({ at: _at, ...step }) => step as RoutineStep),
    },
    route: extra.route,
    createdAt: new Date().toISOString(),
  };
}
