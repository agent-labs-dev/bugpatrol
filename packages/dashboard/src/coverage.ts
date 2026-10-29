import { type CoverageFile, compareCaseIds, HTTP_METHODS } from '@bugpatrol/core';

type CellState = 'pass' | 'fail' | 'blocked' | 'skip' | 'untested';

/**
 * One cell of the matrix. `status` is the status that the case got, not the
 * expected one. An untested cell waits in the sweep cursor.
 */
type MatrixCell = {
  state: CellState;
  status?: number;
  /** Why a cell is blocked or skipped, or the assertion ids that failed. */
  reason?: string;
  exchange?: string;
  at?: string;
};

/**
 * The endpoint × case matrix of `coverage.json`. Rows and columns come from
 * the case keys of the cells, the sweep cursor, and the refused cases, so a
 * `declared:<code>` column exists only for a status that the spec or
 * `connect.errors` declares: the sweep writes such a cell only then.
 */
export type CoverageMatrix = {
  endpoints: string[];
  cases: string[];
  /** Keyed by the case key, `<endpoint> <case>`. A missing key is a case that the sweep does not make. */
  cells: Record<string, MatrixCell>;
  /** The cases that the sweep cursor holds for the next run. */
  remaining: number;
};

export function coverageMatrix(coverage: CoverageFile): CoverageMatrix {
  const next = coverage.cursor?.next ?? [];
  const skipped = coverage.skipped ?? {};
  const cells: Record<string, MatrixCell> = {};
  for (const [key, cell] of Object.entries(coverage.cells))
    cells[key] = {
      state: cell.blocked ? 'blocked' : cell.ok ? 'pass' : 'fail',
      ...(cell.status === undefined ? {} : { status: cell.status }),
      ...(cell.blocked ? { reason: cell.blocked } : cell.failed.length ? { reason: cell.failed.join(', ') } : {}),
      ...(cell.exchange ? { exchange: cell.exchange } : {}),
      at: cell.at,
    };
  // The policy of the last run wins over an older result of the same case.
  for (const [key, reason] of Object.entries(skipped)) cells[key] = { state: 'skip', reason };
  for (const key of next) cells[key] ??= { state: 'untested' };

  const keys = Object.keys(cells).map(splitCaseKey);
  const cases = [...new Set(keys.map((key) => key.case))].sort(compareCaseIds);
  const method = (endpoint: string) => HTTP_METHODS.indexOf(endpoint.split(' ')[0] as (typeof HTTP_METHODS)[number]);
  const endpoints = [...new Set(keys.map((key) => key.endpoint))].sort(
    (a, b) => a.slice(a.indexOf(' ')).localeCompare(b.slice(b.indexOf(' '))) || method(a) - method(b),
  );
  return { endpoints, cases, cells, remaining: next.length };
}

/** A case key is `<method> <template> <case>`, and a case id has no space. */
function splitCaseKey(key: string): { endpoint: string; case: string } {
  const at = key.lastIndexOf(' ');
  return { endpoint: key.slice(0, at), case: key.slice(at + 1) };
}

/** The numbers of a matrix. A `declared:<code>` cell copies the cell of its case, so they count the cases only. */
export type CoverageTotals = {
  endpoints: number;
  /** The endpoints with at least one case that passed or failed. */
  tested: number;
  cases: Record<CellState, number>;
  /** The cases that the sweep cursor holds for the next run. */
  remaining: number;
};

export function coverageTotals(matrix: CoverageMatrix): CoverageTotals {
  const cases: Record<CellState, number> = { pass: 0, fail: 0, blocked: 0, skip: 0, untested: 0 };
  const tested = new Set<string>();
  for (const [key, cell] of Object.entries(matrix.cells)) {
    const { endpoint, case: id } = splitCaseKey(key);
    if (id.startsWith('declared:')) continue;
    cases[cell.state]++;
    if (cell.state === 'pass' || cell.state === 'fail') tested.add(endpoint);
  }
  return { endpoints: matrix.endpoints.length, tested: tested.size, cases, remaining: matrix.remaining };
}
