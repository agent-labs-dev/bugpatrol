import type { Assertion } from './types/agents.js';

/**
 * The stable name of what an assertion checks, for example `status`,
 * `contract:schema` or `pointer:/result/id`. Two results of the same check
 * on two replays or two builds have the same id.
 */
export function assertionId(assertion: Assertion): string {
  switch (assertion.kind) {
    case 'exit-code':
    case 'status':
      return assertion.kind;
    case 'output-includes':
    case 'output-excludes':
    case 'body-includes':
    case 'body-excludes':
      return `${assertion.kind}:${assertion.value}`;
    case 'contract':
      return assertion.check ? `contract:${assertion.check}` : 'contract';
    case 'pointer':
      return `pointer:${assertion.pointer}`;
    case 'header':
      return `header:${assertion.name.toLowerCase()}`;
    case 'schema':
      return `schema:${assertion.ref}`;
  }
}

/**
 * The value at an RFC 6901 JSON pointer, such as `/result/0/id`, or
 * undefined when the pointer does not resolve. A leading `#` is allowed.
 */
export function resolvePointer(value: unknown, pointer: string): { value: unknown } | undefined {
  const path = pointer.replace(/^#/, '');
  if (path === '') return { value };
  if (!path.startsWith('/')) return undefined;
  let current = value;
  for (const token of path.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return { value: current };
}
