import type { HttpMethod } from '../types/agents.js';
import { HTTP_METHODS } from '../types/endpoint.js';

/** One `app.connect.deny` glob: its method, if it names one, and a test of a path. */
export type DenyRule = { glob: string; method?: HttpMethod; test(path: string): boolean };

/**
 * `[METHOD] /path`: `*` is one segment or a part of one, and a `**` segment
 * is any number of segments. Undefined for a glob of another shape, or with an
 * empty segment, which no request path would match.
 */
export function denyRule(glob: string): DenyRule | undefined {
  const parts = glob.trim().split(/\s+/);
  if (parts.length > 2) return undefined;
  const method = parts.length === 2 ? parts[0]!.toUpperCase() : undefined;
  const path = parts.at(-1)!;
  if ((method && !HTTP_METHODS.includes(method as HttpMethod)) || !path.startsWith('/') || path.includes('//'))
    return undefined;
  const source = path
    .split('/')
    .slice(1)
    .map((segment) =>
      segment === '**'
        ? '(?:/[^/]*)*'
        : `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '[^/]*')}`,
    )
    .join('');
  const pattern = new RegExp(`^${source}/?$`, 's');
  return { glob, ...(method ? { method: method as HttpMethod } : {}), test: (value) => pattern.test(value) };
}
