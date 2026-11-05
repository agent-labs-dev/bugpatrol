import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { desktopCommands, onPath, runtimeProblem } from '@bugpatrol/agents';
import { type BugpatrolConfig, ExitCode, type ExitCodeValue, legacyLayout, loadConfig, paths } from '@bugpatrol/core';
import { chromiumProblem } from '@bugpatrol/drivers';

export type DoctorCheck = { name: string; ok: boolean; detail: string; fatal: boolean };

/** The config that doctor checks: the `--config` file, else the default one, and why it did not load. */
export type DoctorConfig = { path: string; config?: BugpatrolConfig; error?: string };

/** The machine probes, as a seam for the tests. */
export type DoctorProbes = { chromium: () => string | undefined };

export function readDoctorConfig(root: string, configFile?: string): DoctorConfig {
  const path = paths.config(root, configFile);
  if (!existsSync(path)) return { path };
  try {
    return { path, config: loadConfig(root, {}, configFile) };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}

function configCheck(root: string, { path, config, error }: DoctorConfig, selected: boolean): DoctorCheck {
  const detail = config
    ? `${path} found`
    : error
      ? error
      : existsSync(path) || selected
        ? `${path} not found`
        : (legacyLayout(root) ?? 'No .bugpatrol/bugpatrol.yml. Run `bugpatrol init`.');
  return { name: 'config', ok: Boolean(config), detail, fatal: true };
}

/**
 * `bugpatrol doctor` checks that this machine can run the selected config:
 * the config itself, Node, the LLM of each agent, and what the platform
 * needs (the browser and the app URL for web, python3 for cli, Xvfb tools
 * for desktop). A gate config also gets the determinism checks.
 */
export async function runChecks(
  root: string,
  loaded: DoctorConfig,
  probes: DoctorProbes = { chromium: chromiumProblem },
): Promise<DoctorCheck[]> {
  const { config } = loaded;
  const checks: DoctorCheck[] = [configCheck(root, loaded, loaded.path !== paths.config(root))];

  if (config?.profile) {
    const where = (file: string) => relative(root, file) || '.';
    checks.push({
      name: 'profile',
      ok: true,
      detail: `${config.profile}: app map and routines in ${where(dirname(paths.appMap(root, config.profile)))}/, run state in ${where(dirname(paths.memory(root, config.profile)))}/`,
      fatal: false,
    });
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    ok: nodeMajor >= 22,
    detail: `Node ${process.versions.node} (need >= 22)`,
    fatal: true,
  });

  // With no config there is no platform to check for: `init` writes one.
  if (!config) return checks;
  checks.push(...agentChecks(config));
  if (config.app.platform === 'web' || config.run) {
    const problem = probes.chromium();
    checks.push({
      name: 'browser',
      ok: !problem,
      detail: problem ?? 'Chromium for Playwright is installed',
      fatal: true,
    });
  }
  const url = await urlCheck(config);
  if (url) checks.push(url);
  if (config.app.platform === 'cli')
    checks.push({
      name: 'cli:python3',
      ok: onPath('python3'),
      detail: onPath('python3') ? 'Installed' : 'The cli driver runs each command in a terminal through python3',
      fatal: true,
    });
  if (config.app.platform === 'desktop') {
    checks.push({
      name: 'desktop-os',
      ok: process.platform === 'linux',
      detail: 'Private Cua desktops require Linux/Xvfb',
      fatal: true,
    });
    for (const command of desktopCommands(config)) {
      const unresolved = command.includes('${');
      checks.push({
        name: `desktop:${command}`,
        ok: unresolved || onPath(command),
        detail: unresolved
          ? 'Resolved from environment/setup at connect time'
          : onPath(command)
            ? 'Installed'
            : 'Missing executable',
        fatal: true,
      });
    }
  }
  // The pinned image and the AppModel belong to the deterministic web gate
  // (`bugpatrol run`). They do not apply to the agents.
  if (!config.run) return checks;

  const image = config.determinism.image;
  const pinned = image.includes('@sha256:');
  checks.push({
    name: 'pinned-image',
    ok: pinned,
    detail: pinned
      ? `Runner image pinned: ${image}`
      : 'determinism.image is not pinned by digest. Baselines captured outside a pinned image will drift against CI.',
    // Not fatal locally -- the local loop is useful without it -- but CI
    // refuses to publish baselines from an unpinned image.
    fatal: false,
  });

  checks.push({
    name: 'app-model',
    ok: existsSync(paths.appModel(root)),
    detail: existsSync(paths.appModel(root))
      ? 'AppModel present'
      : 'No AppModel: `bugpatrol run` captures run.url only',
    fatal: false,
  });

  checks.push({
    name: 'intent-ledger',
    ok: true,
    detail: existsSync(paths.intents(root))
      ? 'Intent Ledger present'
      : 'No Intent Ledger yet (created on first accept)',
    fatal: false,
  });

  return checks;
}

/**
 * A web or API app that no setup command starts must already answer at its
 * URL. Any HTTP response counts: the check is that something listens.
 */
async function urlCheck(config: BugpatrolConfig): Promise<DoctorCheck | undefined> {
  const { platform, setup, connect } = config.app;
  if (platform !== 'web' && platform !== 'api') return undefined;
  if (setup.some((command) => command.background)) return undefined;
  const url = connect.url ?? config.run?.url;
  if (!url) return undefined;
  if (/\$\{|\{\{/.test(url))
    return {
      name: 'url',
      ok: true,
      detail: `${url} is resolved from setup or the environment at connect time`,
      fatal: false,
    };
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return { name: 'url', ok: true, detail: `${url} answers (HTTP ${response.status})`, fatal: true };
  } catch {
    return {
      name: 'url',
      ok: false,
      detail: `Nothing answers at ${url}, and no setup command starts the app. Start it first, or add a background command to app.setup.`,
      fatal: true,
    };
  }
}

/** The checks that the agent commands need: an LLM for each agent, and gh for GitHub. */
function agentChecks(config: BugpatrolConfig, env: NodeJS.ProcessEnv = process.env): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const roles = (['explorer', 'judge', 'fixer'] as const).filter(
    (role) => role !== 'fixer' || config.agents.fixer.enabled,
  );
  for (const role of roles) {
    const use = config.agents[role].use;
    const problem = runtimeProblem(role, use, env);
    const label =
      use.runtime === 'cli'
        ? `cli: ${use.agent ?? use.command.split(' ')[0]}`
        : `${use.via}: ${use.model ?? 'default model'}`;
    checks.push({ name: role, ok: !problem, detail: problem ?? `The ${role} uses ${label}`, fatal: true });
  }
  if (config.agents.github.enabled) {
    const installed = spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0;
    const loggedIn = installed && spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
    checks.push({
      name: 'github',
      ok: loggedIn,
      fatal: false,
      detail: !installed
        ? 'agents.github is on, but the gh CLI is not installed. Install it from https://cli.github.com'
        : loggedIn
          ? 'gh is logged in'
          : 'agents.github is on, but gh is not logged in. Run `gh auth login`.',
    });
  }
  return checks;
}

export function doctorExitCode(checks: DoctorCheck[]): ExitCodeValue {
  return checks.some((c) => c.fatal && !c.ok) ? ExitCode.Usage : ExitCode.Clean;
}
