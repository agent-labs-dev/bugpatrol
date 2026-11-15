import { appendFile, copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  awaitsJudge,
  type Candidate,
  fitLesson,
  formatHttpExchange,
  type Issue,
  paths,
  type Routine,
  shortHash,
  type TriageFile,
} from '@bugpatrol/core';
import { evidenceParts } from '../evidence.js';
import { portabilityWarning } from '../routine-paths.js';
import type { AgentSession } from '../session.js';
import type { Tool, ToolResult } from '../types.js';
import { lessonTools } from './memory.js';

const response = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };

function issueTitle(value: string): string {
  if (value.length <= 80) return value;
  const words = value.trim().split(/\s+/);
  let title = '';
  for (const word of words) {
    const next = title ? `${title} ${word}` : word;
    if (next.length > 79) break;
    title = next;
  }
  return `${title || value.slice(0, 79)}…`;
}

async function decisions(session: AgentSession, sessionId: string): Promise<Set<string>> {
  return new Set((await session.workspace.readDecisions(sessionId)).map((line) => line.candidateId));
}

/**
 * Saves the candidate's flow as a committed routine, so a fresh clone can
 * replay the issue without this run directory. Returns its id, or undefined
 * when the candidate has no flow to replay.
 */
async function saveRepro(
  session: AgentSession,
  issueId: string,
  title: string,
  candidate: Candidate,
  now: string,
): Promise<string | undefined> {
  const { routineId, steps = [], bug } = candidate.evidence;
  if (!routineId && !steps.length) return undefined;
  const routine: Routine = {
    version: 1,
    id: `repro-${issueId.replace(/^iss_/, '')}`,
    description: `Reproduces: ${title}`,
    platform: session.config.app.platform,
    ...(routineId ? { requires: [routineId] } : {}),
    steps,
    screenId: candidate.screenId,
    ...(bug ? { bug } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await session.workspace.saveRoutine(routine);
  const warning = portabilityWarning(routine, session.root);
  if (warning) session.emit({ kind: 'error', summary: warning });
  return routine.id;
}

/** Excludes candidates already accepted or dismissed in the requested sessions. */
export async function pendingCandidates(session: AgentSession, sessionIds: string[]): Promise<Candidate[]> {
  const issues = await session.workspace.listIssues();
  const filed = issues.flatMap((item) => item.candidateIds);
  // A fingerprint filed to a fixed issue passes again, so a later sighting can reopen it as a regression.
  const fixed = new Set(issues.filter((item) => item.status === 'fixed').map((item) => item.id));
  const triaged = Object.entries((await session.workspace.readTriage()).fingerprints)
    .filter(([, entry]) => !(entry.decision === 'filed' && entry.issueId && fixed.has(entry.issueId)))
    .map(([fingerprint]) => fingerprint);
  const pending: Candidate[] = [];
  for (const id of sessionIds) {
    // A candidate of another profile belongs to another app: its repro would land in the wrong folder.
    if ((await session.workspace.readSession(id))?.profile !== session.workspace.profile) continue;
    const decided = new Set([...filed, ...triaged, ...(await decisions(session, id))]);
    for (const candidate of await session.workspace.readCandidates(id))
      if (awaitsJudge(candidate, decided)) pending.push(candidate);
  }
  return pending;
}

/** Pixel diffs are left out: an accepted visual change moves the baseline instead. */
function triageEntries(
  candidates: Candidate[],
  decision: 'filed' | 'dismissed',
  reason: string,
  issueId?: string,
): TriageFile['fingerprints'] {
  const at = new Date().toISOString();
  const entries: TriageFile['fingerprints'] = {};
  for (const candidate of candidates) {
    if (candidate.source === 'pixel-diff') continue;
    entries[candidate.fingerprint] = { decision, issueId, reason, at };
  }
  return entries;
}

/** The pending candidates outside `chosen` that share a fingerprint with one in it: a decision on it decides them. */
function sameFingerprint(pending: Candidate[], chosen: Candidate[]): Candidate[] {
  const prints = new Set(chosen.filter((item) => item.source !== 'pixel-diff').map((item) => item.fingerprint));
  return pending.filter((item) => !chosen.includes(item) && prints.has(item.fingerprint));
}

/** The sentence that names the candidates a decision took along, so none leaves the list unseen. */
function joined(siblings: Candidate[], verb: string): string {
  if (!siblings.length) return '';
  const names = siblings.map((item) => `${item.id} (${item.summary})`).join(', ');
  return ` With the same fingerprint, ${names} ${verb}. If one is a different problem, say so in finish.`;
}

/** Judge tools make every acceptance or dismissal auditable. */
export function judgeTools(session: AgentSession, sessionIds: string[], runtimeLabel: string): Tool[] {
  return [
    ...lessonTools(session, 'judge'),
    {
      name: 'list_candidates',
      description: 'List undecided candidates and existing issues.',
      inputSchema: schema({}),
      async run() {
        const candidates = await pendingCandidates(session, sessionIds);
        const issues = await session.workspace.listIssues();
        const summary = {
          candidates: candidates.map((item) => ({
            id: item.id,
            summary: item.summary,
            severity: item.severity,
            fingerprint: item.fingerprint,
          })),
          issues: issues.map((item) => ({
            id: item.id,
            title: item.title,
            fingerprint: item.fingerprint,
            status: item.status,
          })),
        };
        return response(JSON.stringify(summary));
      },
    },
    {
      name: 'view_candidate',
      description:
        'Inspect a candidate and its evidence before deciding: the screenshot, baseline, and diff, with a terminal the complete output and the colours of each cell, or for an API the HTTP exchange.',
      inputSchema: schema({ id: string }, ['id']),
      async run(input) {
        const candidate = (await pendingCandidates(session, sessionIds)).find((item) => item.id === input.id);
        if (!candidate) return { ...response('Unknown or decided candidate'), isError: true };
        const { capture, ...evidence } = candidate.evidence;
        if (capture.kind === 'http') {
          // The exchange is text, so the model reads it as the server sent it, in the one part.
          const record = JSON.stringify({ ...candidate, evidence }, null, 2);
          const timeline = (await session.workspace.readEvents(candidate.sessionId))
            .filter((event) => ['tool-result', 'candidate', 'session-end', 'error'].includes(event.kind))
            .map(async (event) => {
              const capture = event.capture ? ` capture=${event.capture}` : '';
              let exchange = '';
              if (event.capture?.endsWith('.exchange.json')) {
                try {
                  exchange = `\n${formatHttpExchange(JSON.parse(await readFile(join(session.root, event.capture), 'utf8')))}`;
                } catch {
                  exchange = '';
                }
              }
              return `${event.at} ${event.kind}:${capture} ${event.summary}${exchange}`;
            });
          const timelineText = (await Promise.all(timeline)).join('\n');
          return response(
            `${record}\n\n${formatHttpExchange(capture.exchange)}\n\nSESSION TIMELINE\n${timelineText || '(none recorded)'}`,
          );
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify(candidate, null, 2) },
            ...(await evidenceParts(session.root, capture)),
          ],
        };
      },
    },
    {
      name: 'file_issue',
      description:
        'File a real user problem with an 80-character title, Markdown body, and one-sentence reason; ' +
        'merge candidates with the same cause. To add candidates to an open or fixed issue, pass its issue_id and a ' +
        'reason; the title, body and severity fields are still required by the tool contract and are ignored.',
      inputSchema: {
        ...schema(
          {
            candidate_ids: { type: 'array', items: string },
            issue_id: string,
            title: string,
            body: string,
            severity: { type: 'string', enum: ['cosmetic', 'minor', 'major', 'critical'] },
            reason: string,
          },
          // Keep all creation fields required in the provider-facing schema. The recorded smoke
          // run did not follow the conditional contract, so one unconditional shape is safer.
          ['candidate_ids', 'reason', 'title', 'body', 'severity'],
        ),
      },
      async run(input) {
        if (typeof input.reason !== 'string' || !input.reason.trim()) {
          return { ...response('A one-sentence reason is required'), isError: true };
        }
        const named =
          typeof input.issue_id === 'string' && input.issue_id
            ? await session.workspace.readIssue(input.issue_id)
            : undefined;
        if (named?.status === 'dismissed') {
          return { ...response(`Issue ${named.id} was dismissed; dismiss this candidate instead.`), isError: true };
        }
        if (input.issue_id && !named) {
          return { ...response(`Unknown issue ${String(input.issue_id)}`), isError: true };
        }
        if (!named && (!input.title || !input.body || !input.severity)) {
          return { ...response('A new issue needs a title, a body and a severity'), isError: true };
        }
        // A cut title loses its end, which is often the point: ask for a
        // shorter one instead. The length lets the model fix it in one retry.
        const title = String(input.title ?? '').trim();
        if (!named && title.length > 80) {
          return {
            ...response(`The title has ${title.length} characters; the limit is 80. Write a shorter title.`),
            isError: true,
          };
        }
        const requested = input.candidate_ids as string[];
        const pending = await pendingCandidates(session, sessionIds);
        const chosen = pending.filter((item) => requested.includes(item.id));
        if (chosen.length !== requested.length || !requested.length) {
          return { ...response('Unknown or decided candidate id'), isError: true };
        }
        // Filing decides a fingerprint, so a pending candidate with the same one joins the issue
        // by name, rather than drop out of the pending list with no issue holding it.
        const siblings = sameFingerprint(pending, chosen);
        const candidates = [...chosen, ...siblings];
        const ids = candidates.map((item) => item.id);
        const first = candidates[0]!;
        const now = new Date().toISOString();
        // A named issue wins; otherwise the same fingerprint means the same issue.
        const existing = named ?? (await session.workspace.findIssueByFingerprint(first.fingerprint));
        if (existing?.status === 'dismissed') {
          return { ...response(`Issue ${existing.id} was dismissed; dismiss this candidate instead.`), isError: true };
        }
        let issue: Issue;
        if (existing) {
          // One more occurrence per judging, however many candidates it merges.
          issue = {
            ...existing,
            candidateIds: [...new Set([...existing.candidateIds, ...ids])],
            occurrences: existing.occurrences + 1,
            lastSeenAt: now,
            ...(existing.status === 'fixed'
              ? {
                  status: 'new' as const,
                  regression: { at: now, fromStatus: 'fixed' as const },
                  closedBy: undefined,
                  notSeen: 0,
                }
              : {}),
          };
        } else {
          const id = `iss_${shortHash(`${first.fingerprint}:${now}`)}`;
          const repro = await saveRepro(session, id, issueTitle(title), first, now);
          issue = {
            version: 1,
            id,
            fingerprint: first.fingerprint,
            title: issueTitle(title),
            body: String(input.body),
            severity: input.severity as Issue['severity'],
            status: 'new',
            screenId: first.screenId,
            candidateIds: ids,
            evidence: {
              ...first.evidence,
              ...(repro && { reproRoutineId: repro }),
              ...(session.workspace.profile && { reproProfile: session.workspace.profile }),
            },
            judgement: { by: runtimeLabel, reason: input.reason.trim(), at: now },
            occurrences: 1,
            firstSeenAt: now,
            lastSeenAt: now,
          };
        }
        await session.workspace.saveIssue(issue);
        await session.workspace.recordTriage(triageEntries(candidates, 'filed', issue.judgement.reason, issue.id));
        const merged = Boolean(existing);
        const verb =
          existing?.status === 'fixed' ? 'Regression:' : merged ? `Added to (x${issue.occurrences})` : 'Filed';
        session.emit({ kind: 'issue', summary: `${verb} ${issue.title}` });
        return response(`${verb} ${issue.id}: ${issue.title}${joined(siblings, 'joins the issue')}`);
      },
    },
    {
      name: 'dismiss',
      description: 'Dismiss noise with a reason; set update_baseline for an expected visual change.',
      inputSchema: schema(
        {
          candidate_ids: { type: 'array', items: string },
          reason: string,
          update_baseline: { type: 'boolean' },
        },
        ['candidate_ids', 'reason'],
      ),
      async run(input) {
        const ids = input.candidate_ids as string[];
        const pending = await pendingCandidates(session, sessionIds);
        const candidates = pending.filter((item) => ids.includes(item.id));
        if (candidates.length !== ids.length || !ids.length) {
          return { ...response('Unknown or decided candidate id'), isError: true };
        }
        const siblings = sameFingerprint(pending, candidates);
        for (const candidate of candidates) {
          const { capture } = candidate.evidence;
          if (input.update_baseline && candidate.screenId && capture.kind === 'image') {
            await copyFile(
              resolve(session.root, capture.screenshot),
              paths.agentBaseline(session.root, candidate.screenId, session.workspace.profile),
            );
            const snapshot = join(
              paths.session(session.root, candidate.sessionId, session.workspace.profile),
              `${candidate.screenId}.snapshot.json`,
            );
            try {
              await copyFile(
                snapshot,
                paths.agentBaselineSnapshot(session.root, candidate.screenId, session.workspace.profile),
              );
            } catch {
              // Explorer-only reports may not have a structural snapshot.
            }
          }
          await appendFile(
            paths.sessionDecisions(session.root, candidate.sessionId, session.workspace.profile),
            `${JSON.stringify({
              candidateId: candidate.id,
              decision: 'dismiss',
              reason: input.reason,
              at: new Date().toISOString(),
            })}\n`,
          );
        }
        await session.workspace.recordTriage(triageEntries(candidates, 'dismissed', String(input.reason)));
        if (input.update_baseline !== true)
          for (const candidate of candidates) {
            if (candidate.source !== 'explorer') continue;
            await session.workspace.upsertLessons([
              {
                role: 'explorer',
                source: 'dismissal',
                scope: candidate.screenId,
                text: fitLesson(`Do not report: ${candidate.summary} — ${String(input.reason)}`),
              },
            ]);
          }
        return response(`Dismissed ${candidates.length} candidate(s).${joined(siblings, 'is dismissed with them')}`);
      },
    },
    {
      name: 'finish',
      description: 'Finish judging with one sentence per decision.',
      inputSchema: schema({ summary: string }, ['summary']),
      async run(input) {
        return { ...response(String(input.summary)), done: true };
      },
    },
  ];
}
