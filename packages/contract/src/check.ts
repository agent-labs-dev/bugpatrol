import { type AssertionResult, type ContractCheck, type Endpoint, resolvePointer } from '@bugpatrol/core';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { Contract } from './contract.js';
import { isObject } from './load.js';

/** A response as it came, before redaction. `tooLarge`: the driver did not keep the body. */
export type ContractResponse = {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  text: string;
  tooLarge?: boolean;
};

/**
 * Checks a response against the operation of its endpoint: `contract:status`,
 * `contract:no-5xx`, and, when the spec or `connect.errors` declares the
 * status, `contract:content-type` and `contract:schema`. Declared means the
 * responses of the operation and the statuses of `connect.errors`. A status
 * that only `connect.errors` declares has its body checked against
 * `connect.errors.schema`. A body that the driver did not keep has no schema
 * check.
 */
export function checkContract(endpoint: Endpoint, raw: ContractResponse, contract: Contract): AssertionResult[] {
  const result = (check: ContractCheck, ok: boolean, actual?: string): AssertionResult => ({
    assertion: { kind: 'contract', check },
    ok,
    ...(actual === undefined ? {} : { actual }),
  });
  const operation = resolvePointer(contract.doc, endpoint.specRef)?.value;
  const responses = isObject(operation) && isObject(operation.responses) ? operation.responses : {};
  const key = declaredKey(Object.keys(responses), raw.status);
  const status = String(raw.status);
  const results = [
    result('status', key !== undefined || contract.errors.statuses.includes(raw.status), status),
    result('no-5xx', raw.status < 500, status),
  ];
  if (key !== undefined) {
    const ref = refOf(responses[key]);
    const response = ref === undefined ? responses[key] : resolvePointer(contract.doc, ref)?.value;
    const content = isObject(response) && isObject(response.content) ? response.content : {};
    const type = raw.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    const declared = Object.keys(content);
    const media = declared.find((name) => mediaMatches(name, type)) ?? declared.find(isJson);
    // A response that declares no content has no body.
    const typed = declared.length ? declared.some((name) => mediaMatches(name, type)) : !raw.text;
    results.push(result('content-type', typed, type ?? 'none'));
    const entry = media === undefined ? undefined : content[media];
    if (!raw.tooLarge && media !== undefined && isJson(media) && isObject(entry) && entry.schema !== undefined) {
      const declaredAt = ref ?? `${endpoint.specRef}/responses/${token(key)}`;
      const checked = checkBody(validator(contract, `${declaredAt}/content/${token(media)}/schema`), raw);
      results.push(result('schema', checked.ok, checked.actual));
    }
  } else if (!raw.tooLarge && contract.errors.schema && contract.errors.statuses.includes(raw.status)) {
    const checked = checkBody(validator(contract, ERRORS), raw);
    results.push(result('schema', checked.ok, checked.actual));
  }
  return results;
}

/** Checks a JSON body against the strict schema at `ref`, a pointer into the spec. */
export function checkSchema(ref: string, raw: ContractResponse, contract: Contract): AssertionResult {
  return { assertion: { kind: 'schema', ref }, ...checkBody(validator(contract, ref), raw) };
}

/** The response key of the operation for a status: the exact code, then `4XX`, then `default`. */
function declaredKey(keys: string[], status: number): string | undefined {
  const code = String(status);
  return (
    keys.find((key) => key === code) ??
    keys.find((key) => key.toUpperCase() === `${code[0]}XX`) ??
    keys.find((key) => key === 'default')
  );
}

function mediaMatches(declared: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const name = declared.split(';')[0]!.trim().toLowerCase();
  if (name === '*/*' || name === actual) return true;
  return name.endsWith('/*') && actual.startsWith(name.slice(0, -1));
}

const isJson = (media: string) => /^application\/(?:[\w.-]+\+)?json\b/i.test(media);

function checkBody(schema: ValidateFunction | Error, raw: ContractResponse): { ok: boolean; actual?: string } {
  if (schema instanceof Error) return { ok: false, actual: `the schema does not compile: ${schema.message}` };
  if (raw.tooLarge) return { ok: false, actual: 'the body is over 1 MiB, so Bugpatrol did not keep it' };
  if (raw.json === undefined) return { ok: false, actual: 'the body is not JSON' };
  if (schema(raw.json)) return { ok: true };
  return { ok: false, actual: errorWords(schema) };
}

function errorWords(schema: ValidateFunction): string {
  const errors = schema.errors ?? [];
  const words = errors.slice(0, 3).map((error) => {
    const name = error.params.additionalProperty ?? error.params.unevaluatedProperty;
    return `${error.instancePath || '/'} ${error.message}${name === undefined ? '' : ` (${name})`}`;
  });
  return errors.length > 3 ? `${words.join('; ')}; and ${errors.length - 3} more` : words.join('; ');
}

/** RFC 6901: `~` becomes `~0`, and `/` becomes `~1`. */
const token = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');

/** The `$ref` of a response object that points to `components.responses`. */
const refOf = (response: unknown) =>
  isObject(response) && typeof response.$ref === 'string' ? response.$ref : undefined;

/** The id of the spec in Ajv, and the place of `connect.errors.schema` in it. */
const SPEC = 'bugpatrol:spec';
const ERRORS = '#/errors';

type Validators = { ajv: Ajv2020; cache: Map<string, ValidateFunction | Error> };
const validatorsOf = new WeakMap<Contract, Validators>();

/**
 * The strict validator of the schema at a pointer into the spec, compiled at
 * its first use and cached. A schema that does not compile gives its error,
 * which is a finding on the spec.
 */
function validator(contract: Contract, pointer: string): ValidateFunction | Error {
  let validators = validatorsOf.get(contract);
  if (!validators) {
    validators = { ajv: strictAjv(contract), cache: new Map() };
    validatorsOf.set(contract, validators);
  }
  let compiled = validators.cache.get(pointer);
  if (!compiled) {
    try {
      compiled = validators.ajv.compile({ $ref: `${SPEC}${pointer.startsWith('#') ? pointer : `#${pointer}`}` });
    } catch (error) {
      compiled = error instanceof Error ? error : new Error(String(error));
    }
    validators.cache.set(pointer, compiled);
  }
  return compiled;
}

/**
 * Spike B: `strict` stays on for unknown keywords, and `strictTypes` is off,
 * because it judges how a schema is written, not what it accepts. Ajv does
 * not support `discriminator.mapping`, so `discriminator` is an annotation,
 * like the other keywords that OpenAPI adds to JSON Schema. Formats are not
 * validated. The spec goes into Ajv as one schema, so each `$ref` resolves
 * in it, and its own top-level keys are annotations too.
 */
function strictAjv(contract: Contract): Ajv2020 {
  const { paths, components } = contract.doc;
  const spec = structuredClone({
    paths,
    ...(isObject(components) ? { components } : {}),
    ...(contract.errors.schema ? { errors: contract.errors.schema } : {}),
  });
  closeSpec(spec);
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    discriminator: false,
    validateFormats: false,
    allErrors: true,
  });
  for (const keyword of ['discriminator', 'example', 'xml', 'externalDocs', ...Object.keys(spec)])
    ajv.addKeyword(keyword);
  ajv.addSchema(spec, SPEC);
  return ajv;
}

/** The schemas that a check validates against: each component schema, each response body, and the errors schema. */
function closeSpec(spec: { paths: Record<string, unknown>; components?: Record<string, unknown>; errors?: unknown }) {
  const seen = new WeakSet<object>();
  const closeResponse = (response: unknown) => {
    if (!isObject(response) || !isObject(response.content)) return;
    for (const media of Object.values(response.content)) if (isObject(media)) close(media.schema, seen);
  };
  const { components } = spec;
  for (const schema of Object.values(isObject(components?.schemas) ? components.schemas : {})) close(schema, seen);
  for (const response of Object.values(isObject(components?.responses) ? components.responses : {}))
    closeResponse(response);
  for (const item of Object.values(spec.paths)) {
    if (!isObject(item)) continue;
    for (const operation of Object.values(item))
      if (isObject(operation) && isObject(operation.responses))
        for (const response of Object.values(operation.responses)) closeResponse(response);
  }
  close(spec.errors, seen);
}

const SCHEMA_MAPS = ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions'];
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SCHEMA_ONES = [
  'additionalProperties',
  'unevaluatedProperties',
  'items',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
];

/**
 * Decision 3: a field that the spec does not declare is a bug. Each object
 * with `properties` and no explicit `additionalProperties` (or
 * `unevaluatedProperties`) gets `additionalProperties: false`. An `allOf`
 * whose branches have `properties` gets `unevaluatedProperties: false`
 * instead, and its branches stay open, because each branch sees only its
 * own properties. Extension keys (`x-*`) are dropped, as strict Ajv rejects
 * unknown keywords.
 */
function close(schema: unknown, seen: WeakSet<object>, open = false): void {
  if (!isObject(schema) || seen.has(schema)) return;
  seen.add(schema);
  for (const key of Object.keys(schema)) if (key.startsWith('x-')) delete schema[key];
  const explicit = 'additionalProperties' in schema || 'unevaluatedProperties' in schema;
  const composed =
    Array.isArray(schema.allOf) && schema.allOf.some((branch) => isObject(branch) && isObject(branch.properties));
  if (composed && !explicit) schema.unevaluatedProperties = false;
  else if (!open && !explicit && isObject(schema.properties)) schema.additionalProperties = false;
  for (const key of SCHEMA_MAPS)
    if (isObject(schema[key])) for (const item of Object.values(schema[key])) close(item, seen);
  for (const key of SCHEMA_ONES) close(schema[key], seen);
  for (const key of SCHEMA_LISTS) {
    const items = schema[key];
    if (!Array.isArray(items)) continue;
    for (const item of items)
      close(item, seen, composed && key === 'allOf' && isObject(item) && isObject(item.properties));
  }
}
