import { existsSync } from 'node:fs';
import type { AppConfig, Endpoint, EndpointKey, HttpMethod } from '@bugpatrol/core';
import { HTTP_METHODS, paths } from '@bugpatrol/core';
import { isObject, loadInventory, loadSpec, type OpenApiDoc, type OpenApiOperation, specSource } from './load.js';
import { matcher } from './match.js';

export type SkipReason = 'x-bugpatrol-skip' | 'event-stream';

/** Decision 4b: the error statuses every endpoint may return, and the schema of their body. */
export type ErrorContract = { statuses: number[]; schema?: Record<string, unknown> };

export type Contract = {
  /** The spec without `servers`. Each `Endpoint.specRef` points into it. */
  doc: OpenApiDoc;
  endpoints: Endpoint[];
  skipped: { key: EndpointKey; reason: SkipReason }[];
  errors: ErrorContract;
  /** The endpoint of a request, from its method and its path or URL. */
  match(method: string, url: string): Endpoint | undefined;
};

/**
 * The contract of a project: from `app.connect.spec`, or else from its
 * endpoint inventory. `resolve` fills the placeholders of `spec` and `url`.
 * A project with neither has a contract without endpoints, so only reads go
 * out. A caller that needs endpoints checks for that.
 */
export async function loadContract(
  root: string,
  connect: Pick<AppConfig['connect'], 'spec' | 'url' | 'errors'>,
  resolve: (value: string) => string,
): Promise<Contract> {
  const inventory = paths.endpointInventory(root);
  const doc = connect.spec
    ? await loadSpec(specSource(resolve(connect.spec), { root, url: connect.url && resolve(connect.url) }))
    : existsSync(inventory)
      ? await loadInventory(inventory)
      : { openapi: '3.1.0', paths: {} };
  return buildContract(doc, connect);
}

export function buildContract(doc: OpenApiDoc, connect: Pick<AppConfig['connect'], 'errors'>): Contract {
  const endpoints: Endpoint[] = [];
  const skipped: Contract['skipped'] = [];
  const operationIds = new Set<string>();
  for (const [template, item] of Object.entries(doc.paths)) {
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method.toLowerCase()];
      if (!isObject(operation)) continue;
      const { operationId } = operation as OpenApiOperation;
      // A router mounted two times can repeat an operation under a second path.
      if (operationId !== undefined) {
        if (operationIds.has(operationId)) continue;
        operationIds.add(operationId);
      }
      const key = endpointKey(method, template);
      const reason = skipReason(operation);
      if (reason) {
        skipped.push({ key, reason });
        continue;
      }
      endpoints.push({
        key,
        method,
        template,
        ...(operationId !== undefined ? { operationId } : {}),
        specRef: `#/paths/${pointerToken(template)}/${method.toLowerCase()}`,
      });
    }
  }
  const errors = connect.errors;
  return {
    doc,
    endpoints,
    skipped,
    errors: {
      statuses: [...new Set(errors?.statuses ?? [])].sort((a, b) => a - b),
      ...(errors?.schema ? { schema: errors.schema } : {}),
    },
    match: matcher(endpoints),
  };
}

function endpointKey(method: HttpMethod, template: string): EndpointKey {
  return `${method} ${template}` as EndpointKey;
}

function skipReason(operation: OpenApiOperation): SkipReason | undefined {
  if (operation['x-bugpatrol-skip'] === true) return 'x-bugpatrol-skip';
  // Decision 8: no SSE. An operation that declares an event stream for a success is not tested.
  const streams = Object.entries(operation.responses ?? {}).some(
    ([status, response]) =>
      status.startsWith('2') &&
      isObject(response) &&
      isObject(response.content) &&
      'text/event-stream' in response.content,
  );
  return streams ? 'event-stream' : undefined;
}

/** RFC 6901: `~` becomes `~0`, and `/` becomes `~1`. */
function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
