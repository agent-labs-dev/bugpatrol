import { STATUS_CODES } from 'node:http';
import { resolvePointer } from './assertion.js';
import type { HttpExchange } from './types/evidence.js';

/** The default body cap for a model: the same order as the terminal output cap of the explorer. */
const MAX_BODY_CHARS = 8000;

function body(text: string, max: number): string[] {
  if (!text) return [];
  if (text.length <= max) return ['', text];
  return ['', text.slice(0, max), `[body cut: ${max} of ${text.length} characters shown]`];
}

const headerLines = (headers: Record<string, string>) =>
  Object.entries(headers).map(([name, value]) => `${name}: ${value}`);

/**
 * The one text form of an exchange: what the models read, what an issue or a
 * comment shows in an `http` block, and what the dashboard shows. A body over
 * `maxBodyChars` is cut, and a marker line says so.
 */
export function formatHttpExchange(exchange: HttpExchange, options: { maxBodyChars?: number } = {}): string {
  const max = options.maxBodyChars ?? MAX_BODY_CHARS;
  const { request, response } = exchange;
  const lines = [
    `${request.method} ${request.path}`,
    ...headerLines(request.headers),
    ...body(request.body ?? '', max),
    '',
  ];
  if (!response) {
    lines.push(`No response after ${exchange.latencyMs} ms: ${exchange.error ?? 'unknown error'}`);
    return lines.join('\n');
  }
  const reason = STATUS_CODES[response.status];
  lines.push(`HTTP ${response.status}${reason ? ` ${reason}` : ''} (${exchange.latencyMs} ms)`);
  lines.push(...headerLines(response.headers));
  if (response.tooLarge) lines.push('', `[body not kept: ${response.bytes} bytes, over the read limit]`);
  else {
    lines.push(...body(response.body, max));
    if (response.stream) lines.push(`[stream cut after ${response.bytes} bytes]`);
  }
  return lines.join('\n');
}

/** The exchange as a markdown `http` code block, for issues and comments. */
export function httpBlock(exchange: HttpExchange, options: { maxBodyChars?: number } = {}): string {
  const text = formatHttpExchange(exchange, options);
  // A fence longer than any run of backticks in the text, so a body cannot close it.
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));
  return `${fence}http\n${text}\n${fence}`;
}

/** The most keys that a line names: enough to pick the next pointer, short enough to read. */
const MAX_KEYS = 200;

function keysLine(value: unknown, pointer: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const keys = Object.keys(value);
  const shown = keys.slice(0, MAX_KEYS).join(', ');
  return `Keys at ${pointer || '/'}: ${shown}${keys.length > MAX_KEYS ? ` (${MAX_KEYS} of ${keys.length})` : ''}`;
}

/**
 * The JSON value at a JSON pointer of a document, as indented text: how a
 * model reads one part of a document over the body cap, such as a schema of an
 * OpenAPI spec. A value over `maxChars` is cut, a marker line says so, and an
 * object or an array names its keys, so the next pointer can go deeper. A
 * pointer that does not resolve names the keys where it stops.
 */
export function formatJsonAt(document: unknown, pointer: string, options: { maxChars?: number } = {}): string {
  const max = options.maxChars ?? MAX_BODY_CHARS;
  const found = resolvePointer(document, pointer);
  if (!found) {
    const tokens = pointer.replace(/^#/, '').split('/');
    let prefix = '';
    for (let end = tokens.length - 1; end > 0; end--) {
      prefix = tokens.slice(0, end).join('/');
      if (resolvePointer(document, prefix)) break;
    }
    const keys = keysLine(resolvePointer(document, prefix)?.value, prefix);
    return `Nothing at ${pointer}.${keys ? ` ${keys}` : ''}`;
  }
  const text = JSON.stringify(found.value, null, 2) ?? 'undefined';
  if (text.length <= max) return `${pointer || '/'}:\n${text}`;
  return [
    `${pointer || '/'}:`,
    text.slice(0, max),
    `[value cut: ${max} of ${text.length} characters shown]`,
    keysLine(found.value, pointer) ?? '',
  ].join('\n');
}
