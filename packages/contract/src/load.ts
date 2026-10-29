import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, HTTP_METHODS, type HttpMethod, InfrastructureError, paths } from '@bugpatrol/core';
import { parse as parseYaml } from 'yaml';

/** An OpenAPI 3 operation. Only the keys Bugpatrol reads are typed. */
export type OpenApiOperation = {
  operationId?: string;
  responses?: Record<string, unknown>;
  'x-bugpatrol-skip'?: boolean;
  [key: string]: unknown;
};

/** An OpenAPI 3 document after `loadSpec()`: it never has a `servers` value (T2). */
export type OpenApiDoc = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

export type SpecSource = { url: string } | { file: string };

export type LoadSpecOptions = {
  fetch?: typeof globalThis.fetch;
  /** A real spec can be several MiB, so this limit is far above the 1 MiB limit of a response. */
  maxBytes?: number;
};

const MiB = 1024 * 1024;

/**
 * Where `app.connect.spec` points: an http(s) URL, a path on connect.url
 * such as `/openapi.json`, a file relative to the project root, or an
 * absolute file as a `file:` URL.
 */
export function specSource(spec: string, base: { root: string; url?: string }): SpecSource {
  if (/^https?:\/\//i.test(spec)) return { url: spec };
  if (/^file:/i.test(spec)) return { file: fileURLToPath(spec) };
  if (!spec.startsWith('/')) return { file: resolve(base.root, spec) };
  if (!base.url) throw new ConfigError(`app.connect.spec ${spec} is a path on connect.url, and connect.url is not set`);
  return { url: `${base.url.replace(/\/+$/, '')}${spec}` };
}

/**
 * The doc of a project: `app.connect.spec`, or else its endpoint inventory.
 * Undefined when the project has neither.
 */
export async function projectDoc(
  root: string,
  connect: { spec?: string; url?: string },
): Promise<OpenApiDoc | undefined> {
  if (connect.spec) return loadSpec(specSource(connect.spec, { root, url: connect.url }));
  const inventory = paths.endpointInventory(root);
  return existsSync(inventory) ? loadInventory(inventory) : undefined;
}

export async function loadSpec(src: SpecSource, options: LoadSpecOptions = {}): Promise<OpenApiDoc> {
  const maxBytes = options.maxBytes ?? 16 * MiB;
  const name = 'url' in src ? src.url : src.file;
  const text =
    'url' in src
      ? await download(src.url, maxBytes, options.fetch ?? globalThis.fetch)
      : await read(src.file, maxBytes);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    try {
      doc = parseYaml(text);
    } catch (cause) {
      throw new ConfigError(`The spec ${name} is not JSON or YAML`, { cause });
    }
  }
  if (!isObject(doc) || typeof doc.openapi !== 'string' || !isObject(doc.paths))
    throw new ConfigError(`The spec ${name} is not an OpenAPI 3 document`);
  return withoutServers(doc as OpenApiDoc);
}

/**
 * The no-spec path of decision 1b: `.bugpatrol/endpoints.yml` lists each
 * method and path, as `endpoints: [{method, path}]`. It becomes a doc
 * without schemas.
 */
export async function loadInventory(file: string): Promise<OpenApiDoc> {
  let raw: unknown;
  try {
    raw = parseYaml(await readFile(file, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`Cannot read the endpoint inventory ${file}`, { cause });
  }
  const rows = isObject(raw) ? raw.endpoints : undefined;
  if (!Array.isArray(rows)) throw new ConfigError(`${file} must have an endpoints list of {method, path}`);
  const paths: OpenApiDoc['paths'] = {};
  rows.forEach((row: unknown, index) => {
    const method = isObject(row) && typeof row.method === 'string' ? row.method.toUpperCase() : '';
    const path = isObject(row) ? row.path : undefined;
    if (!HTTP_METHODS.includes(method as HttpMethod) || typeof path !== 'string' || !path.startsWith('/'))
      throw new ConfigError(`${file}: endpoint ${index + 1} needs a method and a path that starts with /`);
    paths[path] = { ...paths[path], [method.toLowerCase()]: { responses: {} } };
  });
  return { openapi: '3.1.0', info: { title: file, version: '0' }, paths };
}

async function read(file: string, maxBytes: number): Promise<string> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (cause) {
    throw new ConfigError(`Cannot read the spec ${file}`, { cause });
  }
  if (size > maxBytes) throw tooLarge(file, maxBytes);
  return readFile(file, 'utf8');
}

async function download(url: string, maxBytes: number, fetch: typeof globalThis.fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json, application/yaml' } });
  } catch (cause) {
    throw new InfrastructureError(`Cannot fetch the spec ${url}`, { cause });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new InfrastructureError(`Cannot fetch the spec ${url}: HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge(url, maxBytes);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw tooLarge(url, maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const tooLarge = (name: string, maxBytes: number) =>
  new ConfigError(`The spec ${name} is larger than ${maxBytes} bytes`);

/** T2: requests always go to connect.url. OpenAPI allows `servers` on the doc, on a path, and on an operation. */
function withoutServers(doc: OpenApiDoc): OpenApiDoc {
  delete doc.servers;
  for (const item of Object.values(doc.paths)) {
    if (!isObject(item)) continue;
    delete item.servers;
    for (const operation of Object.values(item)) if (isObject(operation)) delete operation.servers;
  }
  return doc;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
