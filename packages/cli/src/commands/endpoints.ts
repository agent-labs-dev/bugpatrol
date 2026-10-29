import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Workspace } from '@bugpatrol/agents';
import { buildContract, loadInventory, loadSpec, type OpenApiDoc, specSource } from '@bugpatrol/contract';
import { type BugpatrolConfig, ConfigError, paths } from '@bugpatrol/core';

/**
 * `bugpatrol endpoints [--spec URL|file] [--json]`
 *
 * Prints the endpoints of the api contract and the skipped operations. With
 * no --spec, it reads the spec of the project, or its endpoint inventory, and
 * writes the endpoints to appmap.json.
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

  const doc = spec
    ? await loadSpec(/^https?:\/\//i.test(spec) ? { url: spec } : { file: resolve(spec) })
    : await projectDoc(root, config);
  const contract = buildContract(doc, config?.app.connect ?? {});

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
    log(JSON.stringify({ endpoints: contract.endpoints, skipped: contract.skipped }, null, 2));
    return;
  }
  for (const endpoint of contract.endpoints)
    log(endpoint.operationId ? `${endpoint.key}  ${endpoint.operationId}` : endpoint.key);
  for (const item of contract.skipped) log(`${item.key}  skipped: ${item.reason}`);
  log(`\n${contract.endpoints.length} endpoint(s), ${contract.skipped.length} skipped.`);
}

async function projectDoc(root: string, config?: BugpatrolConfig): Promise<OpenApiDoc> {
  if (!config) throw new ConfigError('bugpatrol endpoints needs --spec, or a project with .bugpatrol/bugpatrol.yml');
  const { connect } = config.app;
  if (connect.spec) return loadSpec(specSource(connect.spec, { root, url: connect.url ?? config.run?.url }));
  const inventory = paths.endpointInventory(root);
  if (existsSync(inventory)) return loadInventory(inventory);
  throw new ConfigError('Set app.connect.spec, commit .bugpatrol/endpoints.yml, or pass --spec');
}
