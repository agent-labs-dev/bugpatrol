import { createHash } from 'node:crypto';
import type { CaseId, EndpointKey } from './types/endpoint.js';

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Short, stable, readable in a GitHub comment. */
export function shortHash(input: string, length = 12): string {
  return sha256(input).slice(0, length);
}

export type RegionBox = { x: number; y: number; width: number; height: number };

export type FingerprintInput = {
  screenId: string;
  ruleId: string;
  regions?: RegionBox[];
  domNodeSignature?: string;
};

/**
 * Grid size, in CSS px, used to bucket diff regions. Deliberately coarse: a
 * finding that shifts by a few pixels must keep its identity rather than
 * re-reporting as new, otherwise suppression, dedup and flake history all
 * break (spec 4.1).
 */
export const REGION_GRID_PX = 32;

export function normalizeRegionSignature(regions: RegionBox[] = [], grid = REGION_GRID_PX): string {
  if (regions.length === 0) return 'none';
  const buckets = new Set<string>();
  for (const r of regions) {
    const x0 = Math.floor(r.x / grid);
    const y0 = Math.floor(r.y / grid);
    const x1 = Math.floor((r.x + r.width) / grid);
    const y1 = Math.floor((r.y + r.height) / grid);
    buckets.add(`${x0},${y0},${x1},${y1}`);
  }
  return [...buckets].sort().join('|');
}

/**
 * The key of an api failure: the endpoint, the case, and the failed check.
 * `assertionId` is an `assertionId()`, or `judge:<rule>` for a bug that only
 * the judge sees. `endpoint: 'spec'` with `case: 'spec'` is a finding on the
 * whole spec. A title is never part of the key, because it changes each run.
 */
export type ApiFingerprintInput = {
  endpoint: EndpointKey | 'spec';
  case: CaseId | 'spec';
  assertionId: string;
};

const FIELD_SEPARATOR = String.fromCharCode(0);

/**
 * fingerprint = hash(screenId, ruleId, normalizedRegionSignature, domNodeSignature),
 * or for an api, hash(endpoint, case, assertionId).
 *
 * The one property that matters: it must survive across runs. Everything
 * downstream -- the Intent Ledger, clustering, flake quarantine, the GitHub
 * issue marker -- is keyed on it, so instability here silently degrades all
 * of them.
 */
export function fingerprint(input: FingerprintInput | ApiFingerprintInput): string {
  if ('endpoint' in input)
    return shortHash(['api', input.endpoint, input.case, input.assertionId].join(FIELD_SEPARATOR), 16);
  const parts = [
    input.screenId,
    input.ruleId,
    normalizeRegionSignature(input.regions),
    input.domNodeSignature ?? 'none',
  ];
  return shortHash(parts.join(FIELD_SEPARATOR), 16);
}

/** hash(content) + imageDigest. An image change invalidates the baseline. */
export function baselineKey(contentHash: string, imageDigest: string): string {
  return `${contentHash}@${imageDigest}`;
}
