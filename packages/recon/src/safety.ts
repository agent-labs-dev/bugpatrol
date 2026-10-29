import type { Decider } from '@bugpatrol/core';
import { IS_DESTRUCTIVE } from '@bugpatrol/decide';

export type ActionClass = 'navigation' | 'safe-action' | 'destructive' | 'external' | 'auth-gated';

const DESTRUCTIVE_COPY = /\b(delete|remove|destroy|revoke|cancel|deactivate|close account|purge|wipe|reset)\b/i;
const EXTERNAL_PROTOCOLS = /^(mailto:|tel:|https?:\/\/(?!localhost|127\.0\.0\.1))/i;

export type ElementCandidate = {
  selector: string;
  text: string;
  href?: string;
  dataAttributes?: Record<string, string>;
};

/**
 * Crawl safety classification. Getting this wrong is the worst possible bug in
 * the product, so ambiguous cases are treated as DESTRUCTIVE (spec 1.3) --
 * the crawler skipping a safe button costs coverage, the crawler clicking a
 * destructive one costs somebody their data.
 */
export async function classifyAction(
  candidate: ElementCandidate,
  options: { origin: string; decider?: Decider } = { origin: '' },
): Promise<{ class: ActionClass; reason: string }> {
  // data-bughunters-* is the name of the same marks before the rename to Bugpatrol.
  const mark = (name: string) =>
    candidate.dataAttributes?.[`bugpatrol${name}`] === 'true' ||
    candidate.dataAttributes?.[`bughunters${name}`] === 'true';
  if (mark('Safe')) {
    return { class: 'safe-action', reason: 'Explicitly marked safe by the repo.' };
  }
  if (mark('Destructive')) {
    return { class: 'destructive', reason: 'Explicitly marked destructive by the repo.' };
  }

  if (candidate.href && EXTERNAL_PROTOCOLS.test(candidate.href) && !candidate.href.startsWith(options.origin)) {
    return { class: 'external', reason: 'Leaves the configured origin.' };
  }

  if (DESTRUCTIVE_COPY.test(candidate.text)) {
    return { class: 'destructive', reason: `Copy matches a destructive verb: "${candidate.text.trim()}".` };
  }

  if (candidate.href) {
    return { class: 'navigation', reason: 'Plain link within the origin.' };
  }

  if (!options.decider) {
    // No decider available and the copy is ambiguous. Default to destructive.
    return { class: 'destructive', reason: 'Ambiguous with no decider available; treated as destructive.' };
  }

  const answers = await options.decider.ask(JSON.stringify(candidate), { destructive: IS_DESTRUCTIVE });
  const answer = answers.destructive;
  if (answer?.kind !== 'noul') {
    return { class: 'destructive', reason: 'No usable answer; treated as destructive.' };
  }
  // Asymmetric threshold: it takes a confident "no" to permit the click.
  if (answer.value < 0.2 && answer.confidence >= 0.85) {
    return { class: 'safe-action', reason: 'Confidently non-destructive.' };
  }
  return { class: 'destructive', reason: `Not confidently safe (p=${answer.value.toFixed(2)}).` };
}
