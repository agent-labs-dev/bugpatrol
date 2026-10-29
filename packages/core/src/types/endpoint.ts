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
