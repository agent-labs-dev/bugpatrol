import { Workspace } from '@bugpatrol/agents';
import { type Candidate, ConfigError, type SessionSummary } from '@bugpatrol/core';

/**
 * `bugpatrol findings list [--session <id>]`: the candidates of the last
 * session that has any, or of the named session, each with what became of
 * it: filed as an issue, dismissed, ignored, or waiting for the judge.
 */
export async function runFindingsCommand(
  args: string[],
  root: string,
  log: (line: string) => void,
  profile?: string,
): Promise<void> {
  const [action = 'list', ...rest] = args;
  if (action !== 'list') throw new ConfigError(`Unknown findings action: ${action}. Use list.`);
  const workspace = new Workspace(root, profile);
  const at = rest.indexOf('--session');
  const named = at >= 0 ? rest[at + 1] : undefined;
  if (at >= 0 && !named) throw new ConfigError('--session needs a session id');
  let session: SessionSummary | undefined;
  let candidates: Candidate[] = [];
  if (named) {
    session = await workspace.readSession(named);
    if (!session) throw new ConfigError(`No session ${named}.`);
    candidates = await workspace.readCandidates(named);
  } else {
    for (const each of await workspace.listSessions(Number.POSITIVE_INFINITY)) {
      candidates = await workspace.readCandidates(each.id);
      if (candidates.length) {
        session = each;
        break;
      }
    }
  }
  if (!session || !candidates.length) {
    log(
      session ? `Session ${session.id} has no findings.` : 'No findings. Run `bugpatrol explore` or `bugpatrol sweep`.',
    );
    return;
  }
  const issues = await workspace.listIssues();
  const triage = (await workspace.readTriage()).fingerprints;
  const decided = new Map((await workspace.readDecisions(session.id)).map((line) => [line.candidateId, line]));
  const outcome = (candidate: Candidate): string => {
    const issue = issues.find((each) => each.candidateIds.includes(candidate.id));
    if (issue) return `filed as ${issue.id}`;
    const decision = decided.get(candidate.id);
    if (decision) return `${decision.decision === 'unverified' ? 'unverified' : 'dismissed'}: ${decision.reason}`;
    const earlier = triage[candidate.fingerprint];
    if (earlier) return earlier.decision === 'filed' ? `filed as ${earlier.issueId}` : `dismissed: ${earlier.reason}`;
    if (candidate.route?.to === 'ignore') return `ignored: ${candidate.route.reason}`;
    if (candidate.route?.to === 'judge') return 'waits for the judge';
    return candidate.route ? `routed to ${candidate.route.to}` : 'not routed';
  };
  log(`Findings of session ${session.id} (${session.role}):`);
  for (const candidate of candidates)
    log(
      `${candidate.id}  ${candidate.severity.padEnd(8)} ${candidate.source.padEnd(9)} ${candidate.summary}  [${outcome(candidate)}]`,
    );
  log(`\n${candidates.length} finding(s). Run \`bugpatrol judge\` to decide the ones that wait.`);
}
