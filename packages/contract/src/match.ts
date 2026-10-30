import type { Endpoint } from '@bugpatrol/core';

/** How one template segment matches, best first: a literal beats a mixed segment, which beats `{param}`. */
type Segment = { rank: 2; literal: string } | { rank: 1; pattern: RegExp } | { rank: 0 };

/**
 * URL to template. The path is split on `/` first, and then each segment is
 * decoded one time, so `%2F` stays inside its segment. Literals compare
 * case-sensitively.
 */
export function matcher<T extends Pick<Endpoint, 'method' | 'template'>>(
  endpoints: T[],
): (method: string, url: string) => T | undefined {
  const compiled = endpoints.map((endpoint) => ({ endpoint, segments: split(endpoint.template).map(compile) }));
  return (method, url) => {
    const wanted = method.toUpperCase();
    const parts = split(pathOf(url)).map(decode);
    let best: (typeof compiled)[number] | undefined;
    for (const candidate of compiled) {
      if (candidate.endpoint.method !== wanted || candidate.segments.length !== parts.length) continue;
      if (!candidate.segments.every((segment, index) => matches(segment, parts[index]!))) continue;
      if (!best || better(candidate.segments, best.segments)) best = candidate;
    }
    return best?.endpoint;
  };
}

function pathOf(url: string): string {
  const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? new URL(url).pathname : url;
  return path.replace(/[?#].*$/s, '');
}

const split = (path: string) => path.split('/').slice(1);

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function compile(segment: string): Segment {
  if (/^\{[^{}]+\}$/.test(segment)) return { rank: 0 };
  if (!segment.includes('{')) return { rank: 2, literal: segment };
  const source = segment
    .split(/\{[^{}]+\}/)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+');
  return { rank: 1, pattern: new RegExp(`^${source}$`, 's') };
}

function matches(segment: Segment, part: string): boolean {
  if (segment.rank === 2) return segment.literal === part;
  if (segment.rank === 1) return segment.pattern.test(part);
  return part !== '';
}

/** The first segment where the two differ decides. */
function better(a: Segment[], b: Segment[]): boolean {
  for (let index = 0; index < a.length; index++) {
    if (a[index]!.rank !== b[index]!.rank) return a[index]!.rank > b[index]!.rank;
  }
  return false;
}
