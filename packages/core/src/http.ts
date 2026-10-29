import { STATUS_CODES } from 'node:http';
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
