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
 * One case of the sweep on an endpoint (decision 6). `declared:<code>` is a
 * declared error status that a case got. The other kinds are requests that
 * the sweep builds from the spec.
 */
export type CaseId =
  | 'ok'
  | `declared:${number}`
  | 'no-auth'
  | 'invalid-input'
  | 'missing-id'
  | 'other-user'
  | 'repeat-delete';

/** The result of one case on one endpoint, from the last sweep that ran it. */
export type CoverageCell = {
  endpoint: EndpointKey;
  case: CaseId;
  /** The status of the request that the case checks. Absent when no response came. */
  status?: number;
  ok: boolean;
  /** The assertion ids that failed. */
  failed: string[];
  /** Why the case did not run, for example "no known id". A blocked cell proves nothing. */
  blocked?: string;
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
  cursor?: { specDigest: string; next: string[] };
};
