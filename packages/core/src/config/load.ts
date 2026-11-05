import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from '../errors.js';
import { BUGPATROL_DIR, CONFIG_FILENAME, legacyLayout, paths, profileOf } from '../paths.js';
import type { runSchema } from './schema.js';
import { type BugpatrolConfig, bugpatrolConfigSchema } from './schema.js';

/**
 * Config precedence: CLI flags > repo bugpatrol.yml > org defaults > detected
 * defaults (spec 9.3). This loader handles the middle two; the CLI layers flags
 * on top of whatever comes back. `root` is the project root: the folder that
 * holds `.bugpatrol/`.
 */
export function loadConfig(
  root = process.cwd(),
  overrides: Partial<BugpatrolConfig> = {},
  configFile?: string,
): BugpatrolConfig {
  const path = paths.config(root, configFile);
  if (!existsSync(path)) {
    if (configFile) throw new ConfigError(`Config file not found: ${path}`);
    const legacy = legacyLayout(root);
    if (legacy) throw new ConfigError(legacy);
    throw new ConfigError(
      `No ${BUGPATROL_DIR}/${CONFIG_FILENAME} found in ${root} or above it. Run \`bugpatrol init\` first.`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`${CONFIG_FILENAME} is not valid YAML`, { cause });
  }

  const profile = profileOf(root, configFile);
  return { ...parseConfig(mergeShallow(raw, overrides), path), ...(profile && { profile }) };
}

export function parseConfig(raw: unknown, source = '<inline>'): BugpatrolConfig {
  const result = bugpatrolConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .flatMap((issue) => {
        const where = issue.path.join('.') || '<root>';
        if (issue.code !== 'unrecognized_keys') return [`  ${where}: ${issue.message}`];
        return issue.keys.map((key) => `  ${where}: Unknown key \`${key}\`.${unknownKeyHint(issue.path, key)}`);
      })
      .join('\n');
    throw new ConfigError(`Invalid config in ${source}:\n${issues}`);
  }
  return result.data;
}

/** The supported field for a key that people write in a setup or teardown command. */
const COMMAND_KEY_HINTS: Record<string, string> = {
  readyUrl: '`readyWhen`: a regex that the command output matches once the app is ready',
  ready: '`readyWhen`: a regex that the command output matches once the app is ready',
  waitFor: '`readyWhen`: a regex that the command output matches once the app is ready',
  command: '`run`',
  cmd: '`run`',
  timeout: '`timeoutMs`',
};

/**
 * Bugpatrol rejects a key that it does not read, so a typo never drops a
 * setting in silence. The hint names the supported field when there is one.
 */
function unknownKeyHint(path: (string | number)[], key: string): string {
  if (path.length === 0 && key === 'profile')
    return ' The profile comes from the file name of `--config`, so remove the key or rename the file.';
  const inCommand = path.length === 3 && path[0] === 'app' && (path[1] === 'setup' || path[1] === 'teardown');
  const hint = inCommand ? COMMAND_KEY_HINTS[key] : undefined;
  return hint
    ? ` Use ${hint}.`
    : ' Bugpatrol does not read it: remove it, or check its spelling in docs/configuration.md.';
}

function mergeShallow(raw: unknown, overrides: Partial<BugpatrolConfig>): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  return { ...(raw as Record<string, unknown>), ...overrides };
}

/**
 * The `run` block, for commands that start a web app themselves. Only
 * `bugpatrol run` and the web driver need it; other platforms start through
 * `app.setup` (ADR 0005).
 */
export function requireRun(config: BugpatrolConfig): z.infer<typeof runSchema> {
  if (!config.run) {
    throw new ConfigError('This command needs a `run` block (command and url) in bugpatrol.yml.');
  }
  return config.run;
}
