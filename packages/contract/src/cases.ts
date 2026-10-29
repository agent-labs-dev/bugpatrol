import {
  type Assertion,
  type CaseId,
  type CoverageCell,
  type CredentialSet,
  type Endpoint,
  type HttpMethod,
  type RoutineStep,
  resolvePointer,
} from '@bugpatrol/core';
import type { Contract } from './contract.js';
import { isObject, type OpenApiDoc } from './load.js';

/** A case that the sweep sends. `declared:<code>` cells come from the results of these. */
export type SweepCaseId = Exclude<CaseId, `declared:${number}`>;

/**
 * One case of one endpoint. Steps without `assert` are setup, for example a
 * list request that captures a known id. Each checked request carries its
 * own assertions. A `blocked` case has no steps.
 */
export type SweepCase = { endpoint: Endpoint; case: SweepCaseId; steps: RoutineStep[]; blocked?: string };

/**
 * `credentials`: the sets that send at least one header. With none, a
 * no-auth case would send the same request as the ok case, so it is blocked.
 */
export type SweepOptions = { credentials: Exclude<CredentialSet, 'none'>[] };

/** The key of a case in the coverage file and the sweep cursor. */
export const caseKey = (endpoint: Endpoint['key'], id: CaseId) => `${endpoint} ${id}`;

/** What one run of a case found, for its coverage cells. */
export type CaseVerdict = {
  endpoint: Endpoint['key'];
  case: SweepCaseId;
  status?: number;
  /** The contract declares the status for the endpoint. */
  declared?: boolean;
  /** The assertion ids that failed. */
  failed: string[];
  blocked?: string;
  repeats?: boolean;
  exchange?: string;
  at: string;
};

/**
 * The cells of one run of a case: its own cell, and for a declared error
 * status, a copy under `declared:<code>`, so the status covers its own column
 * of the matrix. `repeats` stays only on a failure.
 */
export function coverageCells(verdict: CaseVerdict): CoverageCell[] {
  const { status, failed, blocked, repeats, exchange } = verdict;
  const cell: CoverageCell = {
    endpoint: verdict.endpoint,
    case: verdict.case,
    ...(status === undefined ? {} : { status }),
    ok: !blocked && !failed.length,
    failed,
    ...(!blocked && failed.length && repeats !== undefined ? { repeats } : {}),
    ...(blocked ? { blocked } : {}),
    ...(exchange ? { exchange } : {}),
    at: verdict.at,
  };
  return !blocked && verdict.declared && status !== undefined && status >= 400
    ? [cell, { ...cell, case: `declared:${status}` }]
    : [cell];
}

/** The statuses that a negative case expects, best first. A case exists only when the contract declares one. */
const EXPECTED = {
  'no-auth': [401, 403],
  'invalid-input': [422, 400],
  'missing-id': [404],
  'other-user': [404, 403],
} as const;

type Json = Record<string, unknown>;
type Built<T> = T | { blocked: string };
const isBlocked = <T>(value: Built<T>): value is { blocked: string } => isObject(value) && 'blocked' in value;

/**
 * The cases of the sweep for each endpoint (decision 4a), from the spec only,
 * so the same contract gives the same cases. Negative cases exist only for
 * statuses that the spec or `connect.errors` declares anywhere (map section
 * 3). Without `connect.errors`, a spec that declares no errors (rule 4b) gets
 * no negative cases.
 */
export function sweepCases(contract: Contract, options: SweepOptions): SweepCase[] {
  const { doc } = contract;
  const declared = new Set([...contract.errors.statuses, ...contract.endpoints.flatMap((e) => codes(doc, e))]);
  const negative = !specLacksErrors(contract) || contract.errors.statuses.length > 0;
  const cases: SweepCase[] = [];
  for (const endpoint of contract.endpoints) {
    const own = new Set([...contract.errors.statuses, ...codes(doc, endpoint)]);
    const expected = (kind: keyof typeof EXPECTED) =>
      EXPECTED[kind].find((code) => own.has(code)) ?? EXPECTED[kind].find((code) => declared.has(code));
    const plan = new Plan(contract, endpoint);
    const add = (id: SweepCaseId, steps: Built<RoutineStep[]>) =>
      cases.push(
        isBlocked(steps) ? { endpoint, case: id, steps: [], blocked: steps.blocked } : { endpoint, case: id, steps },
      );
    const base = plan.base();
    const last = plan.pathNames.at(-1);
    add('ok', isBlocked(base) ? base : [...base.setup, plan.request(base, { assert: [CONTRACT] })]);

    const noAuth = expected('no-auth');
    if (negative && noAuth && plan.needsAuth())
      add(
        'no-auth',
        !options.credentials.length
          ? { blocked: 'no credentials configured' }
          : isBlocked(base)
            ? base
            : [...base.setup, plan.request(base, { as: 'none', assert: checks(noAuth) })],
      );

    const invalid = expected('invalid-input');
    if (negative && invalid) {
      if (isBlocked(base)) add('invalid-input', base);
      else {
        const steps = plan.invalid(base).map((parts) => plan.request(parts, { assert: checks(invalid) }));
        if (steps.length) add('invalid-input', [...base.setup, ...steps]);
      }
    }

    if (negative && last && expected('missing-id')) {
      const missing = plan.missing(last);
      add('missing-id', isBlocked(missing) ? missing : [plan.request(missing, { assert: checks(404) })]);
    }

    const otherUser = expected('other-user');
    if (negative && last && otherUser && endpoint.method === 'GET')
      add(
        'other-user',
        !options.credentials.includes('other')
          ? { blocked: 'other-user needs a second credential set' }
          : isBlocked(base)
            ? base
            : [
                ...base.setup,
                // Setup: the ok case checks this request, so a bug in it gives one finding, not one for each case.
                plan.request(base, {}),
                plan.request(base, { as: 'other', assert: checks(otherUser) }),
              ],
      );

    if (last && endpoint.method === 'DELETE') {
      // 3c: a second DELETE gives the status of the first, unless the spec declares 404 for it.
      const again = own.has(404) ? 404 : codes(doc, endpoint).find((code) => code >= 200 && code < 300);
      add(
        'repeat-delete',
        isBlocked(base)
          ? base
          : [
              ...base.setup,
              plan.request(base, {}),
              plan.request(base, { assert: again === undefined ? [CONTRACT] : checks(again) }),
            ],
      );
    }
  }
  return cases;
}

/**
 * Rule 4b, as decided in Q2: the spec declares no error status other than
 * 422 on at least 90% of its operations.
 */
export function specLacksErrors(contract: Contract): boolean {
  const { endpoints, doc } = contract;
  if (!endpoints.length) return false;
  const bare = endpoints.filter(
    (endpoint) => !Object.keys(responses(doc, endpoint)).some((key) => /^[45]/.test(key) && key !== '422'),
  );
  return bare.length / endpoints.length >= 0.9;
}

const CONTRACT: Assertion = { kind: 'contract' };
const checks = (status: number): Assertion[] => [CONTRACT, { kind: 'status', value: status }];

/** The parts of one request. Path values are already encoded, or a `{{RESPONSE_*}}` placeholder. */
type Parts = {
  path: Record<string, string>;
  query: Record<string, string>;
  body?: { text: string; type: string };
  setup: RoutineStep[];
};

type Param = { name: string; in: string; required?: boolean; schema?: unknown; example?: unknown; examples?: unknown };

/** How the sweep builds the requests of one endpoint. */
class Plan {
  readonly pathNames: string[];
  private readonly operation: Json;
  private readonly params: Param[];

  constructor(
    private readonly contract: Contract,
    private readonly endpoint: Endpoint,
  ) {
    this.operation = operationOf(contract.doc, endpoint);
    this.params = parameters(contract.doc, endpoint);
    this.pathNames = [...endpoint.template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
  }

  /** The request of the `ok` case: known values everywhere, and a minimal body. */
  base(): Built<Parts> {
    const setup: RoutineStep[] = [];
    const path: Record<string, string> = {};
    for (const name of this.pathNames) {
      const known = explicit(this.contract.doc, this.param('path', name));
      if (known !== undefined) {
        path[name] = encodeURIComponent(known);
        continue;
      }
      if (name !== this.pathNames.at(-1)) return { blocked: `no known ${name}: the spec has no example` };
      const made = producer(this.contract, this.endpoint, name);
      if (isBlocked(made)) return made;
      setup.push(made.step);
      path[name] = made.value;
    }
    const query = this.query();
    if (isBlocked(query)) return query;
    const body = this.body();
    if (isBlocked(body)) return body;
    return { path, query, ...(body ? { body } : {}), setup };
  }

  /** One request with a bad body, and one for each required path or query parameter that has a bad value. */
  invalid(base: Parts): Parts[] {
    const out: Parts[] = [];
    const bad = badBody(this.contract.doc, this.operation);
    if (bad) out.push({ ...base, body: bad });
    for (const param of this.params) {
      if (!param.required || (param.in !== 'path' && param.in !== 'query')) continue;
      const value = badValue(this.contract.doc, param.schema);
      if (value === undefined) continue;
      out.push(
        param.in === 'path'
          ? { ...base, path: { ...base.path, [param.name]: encodeURIComponent(value) } }
          : { ...base, query: { ...base.query, [param.name]: value } },
      );
    }
    return out;
  }

  /** The request with an id that does not exist in place of the last path parameter. No setup runs. */
  missing(name: string): Built<Parts> {
    const path: Record<string, string> = {};
    for (const other of this.pathNames) {
      if (other === name) continue;
      const known = explicit(this.contract.doc, this.param('path', other));
      if (known === undefined) return { blocked: `no known ${other}: the spec has no example` };
      path[other] = encodeURIComponent(known);
    }
    path[name] = encodeURIComponent(missingValue(this.contract.doc, this.param('path', name)?.schema));
    const query = this.query();
    if (isBlocked(query)) return query;
    const body = this.body();
    if (isBlocked(body)) return body;
    return { path, query, ...(body ? { body } : {}), setup: [] };
  }

  /** The spec security, not its scheme (T3): an operation with a required security requirement. */
  needsAuth(): boolean {
    const security = this.operation.security ?? this.contract.doc.security;
    return (
      Array.isArray(security) &&
      security.length > 0 &&
      security.every((item) => isObject(item) && Object.keys(item).length > 0)
    );
  }

  request(parts: Parts, step: { as?: CredentialSet; assert?: Assertion[] }): RoutineStep {
    return request(this.endpoint, parts, step);
  }

  private param(place: string, name: string): Param | undefined {
    return this.params.find((param) => param.in === place && param.name === name);
  }

  private query(): Built<Record<string, string>> {
    const query: Record<string, string> = {};
    for (const param of this.params) {
      if (param.in !== 'query' || !param.required) continue;
      const value = explicit(this.contract.doc, param) ?? scalar(sample(this.contract.doc, param.schema));
      if (value === undefined) return { blocked: `no value for the query parameter ${param.name}` };
      query[param.name] = value;
    }
    return query;
  }

  private body(): Built<Parts['body'] | undefined> {
    return minimalBody(this.contract.doc, this.operation);
  }
}

function request(
  endpoint: Pick<Endpoint, 'method' | 'template'>,
  parts: Pick<Parts, 'path' | 'query' | 'body'>,
  step: { as?: CredentialSet; assert?: Assertion[]; capture?: Record<string, string> },
): RoutineStep {
  const path = endpoint.template.replace(/\{([^{}]+)\}/g, (_, name: string) => parts.path[name]!);
  const search = new URLSearchParams(parts.query).toString();
  return {
    kind: 'request',
    method: endpoint.method,
    url: search ? `${path}?${search}` : path,
    ...(parts.body ? { headers: { 'content-type': parts.body.type }, body: parts.body.text } : {}),
    ...(step.capture ? { capture: step.capture } : {}),
    ...(step.as && step.as !== 'self' ? { as: step.as } : {}),
    ...(step.assert ? { assert: step.assert } : {}),
  };
}

/**
 * A request that makes a known value of the path parameter `name`: a list on
 * the collection above it for a read, a create for a write. A DELETE never
 * deletes a listed resource, only one that it made.
 */
function producer(contract: Contract, endpoint: Endpoint, name: string): Built<{ step: RoutineStep; value: string }> {
  const segments = endpoint.template.split('/');
  const collection = segments.slice(0, segments.indexOf(`{${name}}`)).join('/') || '/';
  const list = endpoint.method === 'DELETE' ? [] : [find(contract, 'GET', collection)];
  const create = find(contract, 'POST', collection);
  const reads = ['GET', 'HEAD', 'OPTIONS'].includes(endpoint.method);
  const capture = `RESPONSE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  for (const source of reads ? [...list, create] : [create, ...list]) {
    if (!source) continue;
    const pointer = idPointer(contract.doc, successSchema(contract.doc, source), name);
    if (!pointer || source.template.includes('{')) continue;
    const body = minimalBody(contract.doc, operationOf(contract.doc, source));
    if (isBlocked(body)) continue;
    return {
      step: request(source, { path: {}, query: {}, ...(body ? { body } : {}) }, { capture: { [capture]: pointer } }),
      value: `{{${capture}}}`,
    };
  }
  return { blocked: `no known ${name}: the spec has no example, and no list or create on ${collection} gives one` };
}

const find = (contract: Contract, method: HttpMethod, template: string) =>
  contract.endpoints.find((item) => item.method === method && item.template === template);

/** The JSON pointer of the id in a response: the property `name`, else `id`. A list gives its first item. */
function idPointer(doc: OpenApiDoc, schema: unknown, name: string): string | undefined {
  let level: [unknown, string][] = [[schema, '']];
  for (let depth = 0; depth < 6 && level.length; depth++) {
    const next: [unknown, string][] = [];
    const nodes = level.flatMap(([node, at]) => branches(doc, node).map((branch): [Json, string] => [branch, at]));
    for (const wanted of [name, 'id'])
      for (const [node, at] of nodes)
        if (isObject(node.properties) && wanted in node.properties) return `${at}/${token(wanted)}`;
    for (const [node, at] of nodes) {
      if (isObject(node.properties))
        for (const [key, child] of Object.entries(node.properties)) next.push([child, `${at}/${token(key)}`]);
      if (node.items !== undefined) next.push([node.items, `${at}/0`]);
    }
    level = next;
  }
  return undefined;
}

/** A schema and the branches of its `allOf`, and the first branch of a `oneOf` or `anyOf`. */
function branches(doc: OpenApiDoc, raw: unknown): Json[] {
  const schema = deref(doc, raw);
  if (!isObject(schema)) return [];
  const out = [schema];
  if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) out.push(...branches(doc, branch));
  for (const key of ['oneOf', 'anyOf'])
    if (Array.isArray(schema[key]) && schema[key].length) out.push(...branches(doc, schema[key][0]));
  return out;
}

function successSchema(doc: OpenApiDoc, endpoint: Endpoint): unknown {
  for (const [code, raw] of Object.entries(responses(doc, endpoint))) {
    const response = deref(doc, raw);
    if (!/^2/.test(code) || !isObject(response) || !isObject(response.content)) continue;
    const media = Object.keys(response.content).find(isJson);
    const entry = media ? response.content[media] : undefined;
    if (isObject(entry)) return entry.schema;
  }
  return undefined;
}

/** The body of a request from the minimal value of its schema: JSON, a form, or multipart (decision 8). */
function minimalBody(doc: OpenApiDoc, operation: Json): Built<Parts['body'] | undefined> {
  const media = bodyMedia(doc, operation);
  if (!media) return undefined;
  if (isBlocked(media)) return media;
  const value = sample(doc, media.schema);
  if (!value) return { blocked: `no value for the ${media.type} body` };
  return encode(media.type, value.value);
}

/** A body that its schema rejects: an object without its required properties, or a value of the wrong type. */
function badBody(doc: OpenApiDoc, operation: Json): Parts['body'] | undefined {
  const media = bodyMedia(doc, operation);
  if (!media || isBlocked(media) || /multipart/i.test(media.type)) return undefined;
  const schema = branches(doc, media.schema);
  const required = schema.some((item) => Array.isArray(item.required) && item.required.length > 0);
  const type = schema.find((item) => item.type !== undefined)?.type;
  const value = required ? {} : type === 'object' ? [] : type === 'array' ? {} : undefined;
  return value === undefined ? undefined : encode(media.type, value);
}

function bodyMedia(doc: OpenApiDoc, operation: Json): Built<{ type: string; schema: unknown }> | undefined {
  const body = deref(doc, operation.requestBody);
  if (!isObject(body) || !isObject(body.content)) return undefined;
  const types = Object.keys(body.content);
  const type =
    types.find(isJson) ??
    types.find((name) => /^application\/x-www-form-urlencoded/i.test(name)) ??
    types.find((name) => /^multipart\/form-data/i.test(name));
  if (!type) return { blocked: `the body type ${types[0] ?? 'none'} is not JSON, a form, or multipart` };
  const entry = body.content[type];
  return { type, schema: isObject(entry) ? entry.schema : undefined };
}

const BOUNDARY = 'bugpatrol-boundary';

function encode(type: string, value: unknown): NonNullable<Parts['body']> {
  if (isJson(type)) return { type: 'application/json', text: JSON.stringify(value) };
  const fields = Object.entries(isObject(value) ? value : {}).map(([name, item]): [string, string] => [
    name,
    typeof item === 'string' ? item : JSON.stringify(item),
  ]);
  if (/^application\/x-www-form-urlencoded/i.test(type))
    return { type: 'application/x-www-form-urlencoded', text: new URLSearchParams(fields).toString() };
  const parts = fields.map(
    ([name, item]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${item}\r\n`,
  );
  return { type: `multipart/form-data; boundary=${BOUNDARY}`, text: `${parts.join('')}--${BOUNDARY}--\r\n` };
}

/**
 * The minimal value of a schema, the same on each run: its `const`,
 * `example`, `default`, first `examples` or first `enum` value, else a value
 * of its type with only the required properties.
 */
function sample(doc: OpenApiDoc, raw: unknown, depth = 0): { value: unknown } | undefined {
  const schema = deref(doc, raw);
  if (!isObject(schema)) return { value: 'bugpatrol' };
  if (depth > 8) return undefined;
  const given = declaredValue(schema);
  if (given) return given;
  if (Array.isArray(schema.allOf)) {
    const merged: Json = {};
    for (const branch of schema.allOf) {
      const part = sample(doc, branch, depth + 1);
      if (!part) return undefined;
      if (!isObject(part.value)) return part;
      Object.assign(merged, part.value);
    }
    if (!isObject(schema.properties)) return { value: merged };
    const own = sample(doc, { ...schema, allOf: undefined }, depth + 1);
    return own && { value: { ...merged, ...(isObject(own.value) ? own.value : {}) } };
  }
  for (const key of ['oneOf', 'anyOf'])
    if (Array.isArray(schema[key]))
      for (const branch of schema[key]) {
        const part = sample(doc, branch, depth + 1);
        if (part) return part;
      }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((item) => item !== 'null') ?? (isObject(schema.properties) ? 'object' : 'string');
  switch (type) {
    case 'integer':
    case 'number': {
      const low =
        typeof schema.minimum === 'number'
          ? schema.minimum
          : typeof schema.exclusiveMinimum === 'number'
            ? schema.exclusiveMinimum + 1
            : 1;
      return { value: typeof schema.maximum === 'number' ? Math.min(low, schema.maximum) : low };
    }
    case 'boolean':
      return { value: false };
    case 'null':
      return { value: null };
    case 'array': {
      const count = typeof schema.minItems === 'number' ? schema.minItems : 0;
      if (!count) return { value: [] };
      const item = sample(doc, schema.items, depth + 1);
      return item && { value: Array.from({ length: count }, () => item.value) };
    }
    case 'object': {
      const properties = isObject(schema.properties) ? schema.properties : {};
      const out: Json = {};
      for (const name of Array.isArray(schema.required) ? schema.required : []) {
        const part = sample(doc, properties[name], depth + 1);
        if (!part) return undefined;
        out[name] = part.value;
      }
      return { value: out };
    }
    default:
      return { value: minimalString(schema) };
  }
}

const FORMATS: Record<string, string> = {
  uuid: '00000000-0000-4000-8000-000000000001',
  'date-time': '2024-01-01T00:00:00Z',
  date: '2024-01-01',
  email: 'bugpatrol@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
};

function minimalString(schema: Json): string {
  const formatted = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
  if (formatted) return formatted;
  const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
  const max = typeof schema.maxLength === 'number' ? schema.maxLength : Number.POSITIVE_INFINITY;
  return 'bugpatrol'.padEnd(min, 'x').slice(0, max);
}

/** A value of a parameter that its schema rejects, or undefined when the schema accepts each string. */
function badValue(doc: OpenApiDoc, raw: unknown): string | undefined {
  const schema = deref(doc, raw);
  if (!isObject(schema)) return undefined;
  if (Array.isArray(schema.enum)) return schema.enum.includes('bugpatrol-invalid') ? undefined : 'bugpatrol-invalid';
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('integer') || types.includes('number'))
    return typeof schema.minimum === 'number' ? String(schema.minimum - 1) : 'bugpatrol';
  if (types.includes('boolean')) return 'bugpatrol';
  if (typeof schema.format === 'string' && schema.format in FORMATS) return 'bugpatrol';
  if (typeof schema.maxLength === 'number') return 'x'.repeat(schema.maxLength + 1);
  return undefined;
}

/** An id that does not exist: in range for a number, a fixed uuid, else a fixed text. */
function missingValue(doc: OpenApiDoc, raw: unknown): string {
  const schema = deref(doc, raw);
  if (!isObject(schema)) return 'bugpatrol-missing';
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('integer') || types.includes('number'))
    return String(typeof schema.maximum === 'number' ? schema.maximum : 2_147_483_647);
  if (schema.format === 'uuid') return 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  return 'bugpatrol-missing';
}

/** A value that the spec gives for a parameter. Only such a value, or a known id, fills a path parameter. */
function explicit(doc: OpenApiDoc, param: Param | undefined): string | undefined {
  if (!param) return undefined;
  const examples = isObject(param.examples) ? Object.values(param.examples).map((item) => deref(doc, item)) : [];
  const given =
    param.example !== undefined
      ? { value: param.example }
      : examples.length && isObject(examples[0]) && 'value' in examples[0]
        ? { value: examples[0].value }
        : declaredValue(deref(doc, param.schema));
  return scalar(given);
}

function declaredValue(schema: unknown): { value: unknown } | undefined {
  if (!isObject(schema)) return undefined;
  for (const key of ['const', 'example', 'default']) if (key in schema) return { value: schema[key] };
  if (Array.isArray(schema.examples) && schema.examples.length) return { value: schema.examples[0] };
  if (Array.isArray(schema.enum) && schema.enum.length) return { value: schema.enum[0] };
  return undefined;
}

const scalar = (given: { value: unknown } | undefined) =>
  given === undefined || given.value === null || given.value === undefined
    ? undefined
    : typeof given.value === 'object'
      ? JSON.stringify(given.value)
      : String(given.value);

/** The parameters of the path item and of the operation. The operation wins on the same name and place. */
function parameters(doc: OpenApiDoc, endpoint: Endpoint): Param[] {
  const item = resolvePointer(doc, endpoint.specRef.slice(0, endpoint.specRef.lastIndexOf('/')))?.value;
  const listed = [
    ...(isObject(item) && Array.isArray(item.parameters) ? item.parameters : []),
    ...(Array.isArray(operationOf(doc, endpoint).parameters)
      ? (operationOf(doc, endpoint).parameters as unknown[])
      : []),
  ];
  const byKey = new Map<string, Param>();
  for (const raw of listed) {
    const param = deref(doc, raw);
    if (isObject(param) && typeof param.name === 'string' && typeof param.in === 'string')
      byKey.set(`${param.in} ${param.name}`, param as Param);
  }
  return [...byKey.values()];
}

function operationOf(doc: OpenApiDoc, endpoint: Endpoint): Json {
  const value = resolvePointer(doc, endpoint.specRef)?.value;
  return isObject(value) ? value : {};
}

function responses(doc: OpenApiDoc, endpoint: Endpoint): Json {
  const { responses } = operationOf(doc, endpoint);
  return isObject(responses) ? responses : {};
}

/** The exact status codes that an operation declares. */
function codes(doc: OpenApiDoc, endpoint: Endpoint): number[] {
  return Object.keys(responses(doc, endpoint))
    .filter((key) => /^\d{3}$/.test(key))
    .map(Number);
}

/** Follows `$ref` to a value in the spec. A ref that does not resolve gives undefined. */
function deref(doc: OpenApiDoc, value: unknown): unknown {
  for (let hops = 0; hops < 16 && isObject(value) && typeof value.$ref === 'string'; hops++)
    value = resolvePointer(doc, value.$ref)?.value;
  return value;
}

const isJson = (media: string) => /^application\/(?:[\w.-]+\+)?json\b/i.test(media);

/** RFC 6901: `~` becomes `~0`, and `/` becomes `~1`. */
const token = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
