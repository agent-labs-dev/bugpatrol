import { appendFile, copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Candidate, type Issue, paths, type Routine, shortHash, type TriageFile } from '@bugpatrol/core';
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
  try {
    const lines = await readFile(join(paths.session(session.root, sessionId), 'decisions.jsonl'), 'utf8');
    return new Set(
      lines
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { candidateId: string }).candidateId),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
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
  const { routineId, steps = [] } = candidate.evidence;
  if (!routineId && !steps.length) return undefined;
  const routine: Routine = {
    version: 1,
    id: `repro-${issueId.replace(/^iss_/, '')}`,
    description: `Reproduces: ${title}`,
    platform: session.config.app.platform,
    ...(routineId ? { requires: [routineId] } : {}),
    steps,
    screenId: candidate.screenId,
    createdAt: now,
    updatedAt: now,
  };
  await session.workspace.saveRoutine(routine);
  return routine.id;
}

/** Excludes candidates already accepted or dismissed in the requested sessions. */
export async function pendingCandidates(session: AgentSession, sessionIds: string[]): Promise<Candidate[]> {
  const issues = await session.workspace.listIssues();
  const filed = new Set(issues.flatMap((item) => item.candidateIds));
  const pending: Candidate[] = [];
  for (const id of sessionIds) {
    const dismissed = await decisions(session, id);
    for (const candidate of await session.workspace.readCandidates(id)) {
      if (candidate.route?.to === 'judge' && !filed.has(candidate.id) && !dismissed.has(candidate.id)) {
        pending.push(candidate);
      }
    }
  }
  return pending;
}

async function image(session: AgentSession, file: string | undefined): Promise<ToolResult['content']> {
  if (!file) return [];
  try {
    return [{ type: 'image', png: await readFile(resolve(session.root, file)) }];
  } catch {
    return [];
  }
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
      description: 'Inspect a candidate and its screenshot, baseline, and diff before deciding.',
      inputSchema: schema({ id: string }, ['id']),
      async run(input) {
        const candidate = (await pendingCandidates(session, sessionIds)).find((item) => item.id === input.id);
        if (!candidate) return { ...response('Unknown or decided candidate'), isError: true };
        return {
          content: [
            { type: 'text', text: JSON.stringify(candidate, null, 2) },
            ...(await image(session, candidate.evidence.screenshot)),
            ...(await image(session, candidate.evidence.baseline)),
            ...(await image(session, candidate.evidence.diff)),
          ],
        };
      },
    },
    {
      name: 'file_issue',
      description:
        'File a real user problem with an 80-character title, Markdown body, and one-sentence reason; ' +
        'merge candidates with the same cause. To add candidates to an open or fixed issue, pass its issue_id and a ' +
        'reason; the title, body and severity are then not needed.',
      inputSchema: schema(
        {
          candidate_ids: { type: 'array', items: string },
          issue_id: string,
          title: string,
          body: string,
          severity: { type: 'string', enum: ['cosmetic', 'minor', 'major', 'critical'] },
          reason: string,
        },
        ['candidate_ids', 'reason'],
      ),
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
        const ids = input.candidate_ids as string[];
        const candidates = (await pendingCandidates(session, sessionIds)).filter((item) => ids.includes(item.id));
        if (candidates.length !== ids.length || !ids.length) {
          return { ...response('Unknown or decided candidate id'), isError: true };
        }
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
            evidence: repro ? { ...first.evidence, reproRoutineId: repro } : first.evidence,
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
        return response(`${verb} ${issue.id}: ${issue.title}`);
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
        const candidates = (await pendingCandidates(session, sessionIds)).filter((item) => ids.includes(item.id));
        if (candidates.length !== ids.length || !ids.length) {
          return { ...response('Unknown or decided candidate id'), isError: true };
        }
        for (const candidate of candidates) {
          if (input.update_baseline && candidate.screenId && candidate.evidence.screenshot) {
            await copyFile(
              resolve(session.root, candidate.evidence.screenshot),
              paths.agentBaseline(session.root, candidate.screenId),
            );
            const snapshot = join(
              paths.session(session.root, candidate.sessionId),
              `${candidate.screenId}.snapshot.json`,
            );
            try {
              await copyFile(snapshot, paths.agentBaselineSnapshot(session.root, candidate.screenId));
            } catch {
              // Explorer-only reports may not have a structural snapshot.
            }
          }
          await appendFile(
            join(paths.session(session.root, candidate.sessionId), 'decisions.jsonl'),
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
                text: `Do not report: ${candidate.summary} — ${String(input.reason)}`.slice(0, 200),
              },
            ]);
          }
        return response(`Dismissed ${candidates.length} candidate(s).`);
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
