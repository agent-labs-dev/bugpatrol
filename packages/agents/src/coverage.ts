import type { Contract } from '@bugpatrol/contract';
import type { CoverageCell, CoverageFile, Endpoint } from '@bugpatrol/core';

/** One endpoint that the explorer tests first, and why. */
export type ExplorerTarget = { endpoint: Endpoint; reason: string };

type Group = [reason: string, test: (endpoint: Endpoint) => boolean];

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The endpoints that the explorer tests first (decision 4a), at most `n`.
 * The groups come in this order: endpoints with no coverage, sweep failures
 * that did not repeat, write operations (only when writes are allowed), and
 * cross-user cases (only with a second credential set). The other endpoints
 * come last. In each group, the endpoint whose newest cell is oldest comes
 * first, so each run moves on: an explorer request writes a new cell.
 */
export function rankForExplorer(
  coverage: CoverageFile | undefined,
  contract: Contract,
  n: number,
  options: { writesAllowed: boolean; crossUser: boolean },
): ExplorerTarget[] {
  const cells = new Map<string, CoverageCell[]>();
  for (const cell of Object.values(coverage?.cells ?? {}))
    cells.set(cell.endpoint, [...(cells.get(cell.endpoint) ?? []), cell]);
  const newest = (endpoint: Endpoint) =>
    (cells.get(endpoint.key) ?? []).reduce((at, cell) => (cell.at > at ? cell.at : at), '');
  const groups: Group[] = [
    ['no coverage yet', (endpoint) => !cells.has(endpoint.key)],
    [
      'a sweep failure that did not repeat',
      (endpoint) => cells.get(endpoint.key)!.some((cell) => cell.repeats === false),
    ],
    ...(options.writesAllowed
      ? [['a write operation', (endpoint) => WRITES.has(endpoint.method)] satisfies Group]
      : []),
    // A path parameter names one resource, which belongs to one user.
    ...(options.crossUser
      ? [['a cross-user case', (endpoint) => endpoint.template.includes('{')] satisfies Group]
      : []),
    ['the oldest coverage', () => true],
  ];
  const groupOf = (endpoint: Endpoint) => groups.findIndex(([, test]) => test(endpoint));
  return contract.endpoints
    .map((endpoint, index) => ({ endpoint, index, group: groupOf(endpoint), at: newest(endpoint) }))
    .sort((a, b) => a.group - b.group || a.at.localeCompare(b.at) || a.index - b.index)
    .slice(0, n)
    .map(({ endpoint, group }) => ({ endpoint, reason: groups[group]![0] }));
}
