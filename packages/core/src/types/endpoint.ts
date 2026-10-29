import type { HttpMethod } from './agents.js';

declare const brand: unique symbol;

/** Each `HttpMethod`, for code that iterates or validates them. */
export const HTTP_METHODS = [
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const satisfies readonly HttpMethod[];

/**
 * The one name of an endpoint, the method and the route template, for example
 * `GET /items/{id}`. Only `buildContract()` in `@bugpatrol/contract` makes one.
 */
export type EndpointKey = string & { readonly [brand]: 'EndpointKey' };

/** One operation of the api contract. */
export type Endpoint = {
  key: EndpointKey;
  method: HttpMethod;
  /** The path template of the spec, for example `/items/{id}`. */
  template: string;
  operationId?: string;
  /** A JSON pointer to the operation in the spec, for example `#/paths/~1items~1{id}/get`. */
  specRef: string;
};

/**
 * The cases of the sweep, in the order of the matrix columns. `declared`
 * stands for each `declared:<code>` case.
 */
export const CASE_IDS = [
  'ok',
  'declared',
  'no-auth',
  'invalid-input',
  'missing-id',
  'other-user',
  'repeat-delete',
] as const;

/**
 * One case of the sweep on an endpoint (decision 6). `declared:<code>` is a
 * declared error status that a case got. The other kinds are requests that
 * the sweep builds from the spec.
 */
export type CaseId = Exclude<(typeof CASE_IDS)[number], 'declared'> | `declared:${number}`;

/** Sorts case ids in the order of `CASE_IDS`, and `declared:<code>` cases by code. */
export function compareCaseIds(a: string, b: string): number {
  const order = (id: string) => (CASE_IDS as readonly string[]).indexOf(id.startsWith('declared:') ? 'declared' : id);
  return order(a) - order(b) || a.localeCompare(b);
}

/** The result of one case on one endpoint, from the last sweep that ran it. */
export type CoverageCell = {
  endpoint: EndpointKey;
  case: CaseId;
  /** The status of the request that the case checks. Absent when no response came. */
  status?: number;
  ok: boolean;
  /** The assertion ids that failed. */
  failed: string[];
  /** A sweep failure: it came back on a second run. The explorer looks first at one that did not. */
  repeats?: boolean;
  /** Why the case did not run, for example "no known id". A blocked cell proves nothing. */
  blocked?: string;
  /** The workspace-relative `.exchange.json` file of the checked request. */
  exchange?: string;
  at: string;
};

/**
 * `coverage.json`. `cells` is keyed by the case key, `<endpoint key> <case>`.
 * `cursor.next` holds the case keys that the current pass did not run yet,
 * so the next sweep resumes there. A new spec digest starts a new pass.
 */
export type CoverageFile = {
  version: 1;
  cells: Record<string, CoverageCell>;
  /** The case keys that the request policy refused in the last run, with the reason. They send nothing. */
  skipped?: Record<string, string>;
  cursor?: { specDigest: string; next: string[] };
};
