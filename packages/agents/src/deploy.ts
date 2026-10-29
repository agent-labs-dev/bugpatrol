import { type AppConfig, type BugpatrolConfig, resolvePointer } from '@bugpatrol/core';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

export type VersionSource = NonNullable<AppConfig['connect']['version']>;

/** The commit that the backend runs, or why it is not known yet. */
export type Deploy = { commit: string } | { pending: string };

/**
 * A backend that Bugpatrol does not start: an api app with no background
 * setup step. Its code changes only with a deploy, so a commit or a fix
 * branch says nothing about what it runs.
 */
export function externalBackend(app: AppConfig): boolean {
  return app.platform === 'api' && !app.setup.some((step) => step.background);
}

/**
 * The values at a JSON pointer. A `*` segment takes each element of an
 * array, and an array at the end gives each of its elements.
 */
function pointerValues(value: unknown, pointer: string): unknown[] {
  const [first = '', ...rest] = pointer.split(/\/\*(?=\/|$)/);
  const at = (item: unknown, part: string) => {
    const found = resolvePointer(item, part);
    return found ? [found.value] : [];
  };
  let values = at(value, first);
  for (const part of rest)
    values = values.flatMap((item) => (Array.isArray(item) ? item.flatMap((element) => at(element, part)) : []));
  return values.flatMap((item) => (Array.isArray(item) ? item : [item]));
}

/**
 * The only owner of "which commit is live". A fleet is live on a commit
 * only when every process reports it: a mixed fleet, a missing commit, or
 * a failed request is pending, never an error.
 */
export async function deployedCommit(
  url: string,
  version: VersionSource,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Deploy> {
  const target = `${url.replace(/\/+$/, '')}${version.path}`;
  let body: unknown;
  try {
    const response = await fetchImpl(target, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { pending: `${version.path} answered ${response.status}` };
    body = await response.json();
  } catch (error) {
    return { pending: `${version.path} failed: ${(error as Error).message}` };
  }
  const values = pointerValues(body, version.pointer);
  if (!values.length) return { pending: `${version.path} has nothing at ${version.pointer}` };
  if (values.some((value) => typeof value !== 'string' || !value))
    return { pending: `a process of ${version.path} reports no commit` };
  const commits = [...new Set(values as string[])];
  if (commits.length > 1) return { pending: `the fleet runs ${commits.length} commits: ${commits.join(', ')}` };
  return { commit: commits[0]! };
}

/**
 * Probe `app.connect.version` and keep the answer in `deploy.json`, so the
 * merged-fix recheck of this cycle reads the same answer. Undefined when the
 * app has no version endpoint.
 */
export async function probeDeploy(
  root: string,
  config: BugpatrolConfig,
  fetchImpl?: typeof globalThis.fetch,
): Promise<Deploy | undefined> {
  const { version, url = config.run?.url } = config.app.connect;
  if (!version) return undefined;
  let deploy: Deploy;
  try {
    if (!url) throw new Error('app.connect.url is not set');
    deploy = await deployedCommit(new Vars(config.app.secrets).resolve(url), version, fetchImpl);
  } catch (error) {
    deploy = { pending: (error as Error).message };
  }
  await new Workspace(root).writeDeploy({ version: 1, ...deploy, checkedAt: new Date().toISOString() });
  return deploy;
}
