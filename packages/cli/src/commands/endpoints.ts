import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Vars, Workspace } from '@bugpatrol/agents';
import { loadContract, requestPolicy } from '@bugpatrol/contract';
import { type BugpatrolConfig, ConfigError, type Endpoint } from '@bugpatrol/core';

/**
 * `bugpatrol endpoints [--spec URL|file] [--json]`
 *
 * Prints the endpoints of the api contract, what the request policy allows
 * for each (`allowed`, `read-only`, or `denied: <reason>`), and the skipped
 * operations. With no --spec, it reads the spec of the project, or its
 * endpoint inventory, and writes the endpoints to appmap.json.
 */
export async function runEndpointsCommand(
  args: string[],
  root: string,
  log: (line: string) => void,
  config?: BugpatrolConfig,
): Promise<void> {
  const json = args.includes('--json');
  const specAt = args.indexOf('--spec');
  const spec = specAt >= 0 ? args[specAt + 1] : undefined;
  if (specAt >= 0 && (!spec || spec.startsWith('-'))) throw new ConfigError('--spec needs a URL or a file');
  const unknown = args.filter((arg, index) => arg !== '--json' && index !== specAt && index !== specAt + 1);
  if (unknown.length) throw new ConfigError(`Unknown argument for bugpatrol endpoints: ${unknown.join(' ')}`);

  if (!spec && !config)
    throw new ConfigError('bugpatrol endpoints needs --spec, or a project with .bugpatrol/bugpatrol.yml');
  const vars = new Vars(config?.app.secrets);
  const resolveConfig = vars.resolveConfig.bind(vars);
  const connect = config?.app.connect;
  const url = connect?.url ?? config?.run?.url;
  // A --spec that is not a URL is a file from the working directory.
  const given = spec && (/^[a-z][a-z\d+.-]*:/i.test(spec) ? spec : pathToFileURL(resolve(spec)).href);
  const contract = await loadContract(root, { ...connect, url, ...(given ? { spec: given } : {}) }, resolveConfig);
  if (!given && !contract.endpoints.length && !contract.skipped.length)
    throw new ConfigError('No endpoints: set app.connect.spec, commit .bugpatrol/endpoints.yml, or pass --spec');
  const policy = connect && url ? requestPolicy(contract, { ...connect, url: resolveConfig(url) }) : undefined;
  const access = (endpoint: Endpoint): string | undefined => {
    const verdict = policy?.check(endpoint.method, endpoint.template);
    if (!verdict) return undefined;
    if (verdict.ok) return 'allowed';
    return verdict.readOnly ? 'read-only' : `denied: ${verdict.reason}`;
  };

  if (!spec && config) {
    const workspace = new Workspace(root);
    const map = await workspace.readAppMap();
    await workspace.writeAppMap({
      version: 1,
      platform: map?.platform ?? config.app.platform,
      ...map,
      screens: map?.screens ?? [],
      endpoints: contract.endpoints,
      updatedAt: new Date().toISOString(),
    });
  }

  if (json) {
    const endpoints = contract.endpoints.map((endpoint) => ({ ...endpoint, access: access(endpoint) }));
    log(JSON.stringify({ endpoints, skipped: contract.skipped }, null, 2));
    return;
  }
  for (const endpoint of contract.endpoints)
    log([endpoint.key, endpoint.operationId, access(endpoint)].filter(Boolean).join('  '));
  for (const item of contract.skipped) log(`${item.key}  skipped: ${item.reason}`);
  log(`\n${contract.endpoints.length} endpoint(s), ${contract.skipped.length} skipped.`);
}
