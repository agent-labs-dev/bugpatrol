import type { ArtifactRef, FileRef, FindingId, FlowId, GroupId, RunId, ScreenId } from './ids.js';
import type { Action } from './project.js';

export type Tier = 'tier1' | 'tier2' | 'tier3';

export type Classification =
  | 'regression'
  | 'visual-noise'
  | 'functional-bug'
  | 'a11y'
  | 'content'
  | 'flow'
  | 'improvement'
  | 'perf';

export type Severity = 'cosmetic' | 'minor' | 'major' | 'critical';

/** Where a finding surfaces. Only tier-1 findings may ever route to `check`. */
export type Route = 'check' | 'issue' | 'question' | 'intent' | 'ignore';

export type NetworkFailure = {
  url: string;
  method: string;
  status?: number;
  sameOrigin: boolean;
  error?: string;
};

export type FindingEvidence = {
  before?: ArtifactRef;
  after?: ArtifactRef;
  diff?: ArtifactRef;
  video?: ArtifactRef;
  trace?: ArtifactRef;
  /** The compact, GitHub-attachable highlight clip (spec 5.6). */
  clip?: ArtifactRef;
  console?: string[];
  network?: NetworkFailure[];
  reproSteps?: Action[];
};

export type FindingStatus = 'open' | 'triaged' | 'accepted' | 'muted' | 'quarantined' | 'fixed' | 'question';

export type Finding = {
  id: FindingId;
  runId: RunId;
  /** Stable across runs. Powers suppression, dedup, flake history and the Ledger. */
  fingerprint: string;
  rootCauseGroupId?: GroupId;
  screenId?: ScreenId;
  viewport?: string;
  flowId?: FlowId;
  /** Which detector fired. */
  ruleId: string;
  tier: Tier;
  classification: Classification;
  severity: Severity;
  confidence: number;
  route: Route;
  /**
   * One sentence naming a consequence (spec 8.8). "4.3% of pixels changed"
   * fails this test; "the primary action is no longer reachable" passes it.
   */
  summary: string;
  evidence: FindingEvidence;
  suspectedFiles: FileRef[];
  status: FindingStatus;
  issueNumber?: number;
  fixPullNumber?: number;
};
