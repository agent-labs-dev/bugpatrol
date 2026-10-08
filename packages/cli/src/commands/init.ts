import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { onPath } from '@bugpatrol/agents';
import {
  type AgentRole,
  BUGPATROL_DIR,
  CLI_AGENTS,
  type CliAgent,
  CONFIG_FILENAME,
  ConfigError,
  cliPreset,
  DATA_DIR,
  layout,
  legacyLayout,
  type Platform,
  paths,
  type StackProfile,
} from '@bugpatrol/core';
import { detectBringUp, detectStack } from '@bugpatrol/recon';

export type { Platform } from '@bugpatrol/core';
export const PLATFORMS: Platform[] = ['web', 'electron', 'ios', 'android', 'api', 'desktop'];

/** Model routes that need only an API key. */
export const KEY_PROVIDERS = {
  openrouter: {
    env: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    url: 'https://openrouter.ai/keys',
    model: 'z-ai/glm-5.3-flash',
  },
  vercel: {
    env: 'AI_GATEWAY_API_KEY',
    label: 'Vercel AI Gateway',
    url: 'https://vercel.com/ai-gateway',
    model: 'anthropic/claude-haiku-4.5',
  },
  openai: { env: 'OPENAI_API_KEY', label: 'OpenAI', url: 'https://platform.openai.com/api-keys', model: 'gpt-5-mini' },
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    url: 'https://console.anthropic.com/settings/keys',
    model: 'claude-haiku-4-5',
  },
} as const;
export type KeyProvider = keyof typeof KEY_PROVIDERS;
export type Provider = CliAgent | KeyProvider;

const CLI_LABELS: Record<CliAgent, string> = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi CLI', pi: 'pi' };

export type Detected = {
  /** Agent CLIs on PATH that can run a role. */
  clis: CliAgent[];
  /** Model routes with a key in the environment. */
  keys: KeyProvider[];
  /** pi is on PATH but has no MCP: it needs pi-mcp-adapter. */
  piWithoutMcp: boolean;
  /** pi has pi-permission-modes, which blocks tool calls in print mode unless --perm yolo. */
  piPermissionModes: boolean;
};

type Run = (command: string, args: string[]) => string;
const run: Run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 }).stdout ?? '';

export function detectProviders(env: NodeJS.ProcessEnv = process.env, exec: Run = run): Detected {
  const found = CLI_AGENTS.filter((agent) => onPath(agent, env));
  const piList = found.includes('pi') ? exec('pi', ['list']) : '';
  const piWithoutMcp = found.includes('pi') && !piList.includes('pi-mcp-adapter');
  return {
    clis: found.filter((agent) => agent !== 'pi' || !piWithoutMcp),
    keys: (Object.keys(KEY_PROVIDERS) as KeyProvider[]).filter((key) => env[KEY_PROVIDERS[key].env]),
    piWithoutMcp,
    piPermissionModes: piList.includes('pi-permission-modes'),
  };
}

export type AppGuess = {
  platform: Platform;
  start?: string;
  url?: string;
  appId?: string;
  cdpPort?: number;
  /** The regex for the start command's output when the app is ready. */
  ready?: string;
  /** Where each guess came from, for the summary. */
  notes: string[];
};

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const FRAMEWORK_PORTS: Record<string, number> = { vite: 5173, next: 3000, angular: 4200, django: 8000, rails: 3000 };
/**
 * The line that each dev server prints when it can serve a page. The URL line
 * is too early for some: `next dev` prints it before it is ready.
 */
const FRAMEWORK_READY: Record<string, string> = {
  next: 'Ready in|✓ Ready',
  vite: 'ready in|Local:',
  angular: 'Compiled successfully|Local:',
  django: 'Quit the server with',
  rails: 'Listening on',
};

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The Xcode projects at the root and in ios/, as project.pbxproj paths. */
function xcodeProjects(root: string): string[] {
  return ['.', 'ios'].flatMap((dir) =>
    list(join(root, dir))
      .filter((name) => name.endsWith('.xcodeproj'))
      .map((name) => join(root, dir, name, 'project.pbxproj')),
  );
}

/** The Gradle files of an Android app module, at the root or in android/. */
function gradleFiles(root: string): string[] {
  return ['android/app', 'app']
    .flatMap((dir) => ['build.gradle', 'build.gradle.kts'].map((file) => join(root, dir, file)))
    .filter((file) => existsSync(file));
}

/** The bundle ID (iOS) or package name (Android), and the file it came from. */
export function detectAppId(root: string, platform: 'ios' | 'android'): { appId: string; source: string } | undefined {
  const expo = readJson<{ expo?: { ios?: { bundleIdentifier?: string }; android?: { package?: string } } }>(
    join(root, 'app.json'),
  )?.expo;
  const fromJson = platform === 'ios' ? expo?.ios?.bundleIdentifier : expo?.android?.package;
  if (fromJson) return { appId: fromJson, source: 'app.json' };
  for (const file of ['app.config.ts', 'app.config.js']) {
    const match = readText(join(root, file)).match(
      platform === 'ios' ? /bundleIdentifier:\s*['"`]([\w.-]+)['"`]/ : /package:\s*['"`]([\w.-]+)['"`]/,
    );
    if (match) return { appId: match[1]!, source: file };
  }
  if (platform === 'ios') {
    for (const file of xcodeProjects(root)) {
      const ids = [...readText(file).matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([\w.-]+)"?;/g)].map((match) => match[1]!);
      // The app target, not its test targets.
      const appId = ids.find((id) => !/tests?$/i.test(id));
      if (appId) return { appId, source: file.slice(root.length + 1) };
    }
    return undefined;
  }
  for (const file of gradleFiles(root)) {
    const match = readText(file).match(/applicationId\s*=?\s*["']([\w.-]+)["']/);
    if (match) return { appId: match[1]!, source: file.slice(root.length + 1) };
  }
  return undefined;
}

/** A dev server port from the scripts, the Vite config, or .env; else the framework default. */
function detectPort(root: string, pkg: PackageJson, framework?: string): { port: number; source: string } {
  const scripts = Object.values(pkg.scripts ?? {}).join(' ');
  const fromScript = scripts.match(/(?:--port[= ]|-p )(\d{2,5})\b/)?.[1];
  if (fromScript) return { port: Number(fromScript), source: 'package.json' };
  for (const file of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    const match = readText(join(root, file)).match(/\bport:\s*(\d{2,5})\b/);
    if (match) return { port: Number(match[1]), source: file };
  }
  const fromEnv = readText(join(root, '.env')).match(/^PORT=(\d{2,5})\s*$/m)?.[1];
  if (fromEnv) return { port: Number(fromEnv), source: '.env' };
  return {
    port: (framework && FRAMEWORK_PORTS[framework]) || 3000,
    source: framework ? `the ${framework} default` : 'the usual default',
  };
}

/** The platform that this machine can run a mobile app on. */
function mobilePlatform(root: string): 'ios' | 'android' {
  const hasIos = xcodeProjects(root).length > 0 || existsSync(join(root, 'app.json')) || existsSync(join(root, 'ios'));
  return process.platform === 'darwin' && hasIos ? 'ios' : 'android';
}

/**
 * A first guess at the platform, the start command, and the URL or app ID,
 * each with where it came from. The interview puts each guess on the input
 * line, so the user presses Enter or edits it.
 */
export function detectApp(root: string): AppGuess {
  const pkg = readJson<PackageJson>(join(root, 'package.json')) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const notes: string[] = [];

  if (deps.electron) {
    notes.push('Platform electron: detected from package.json.');
    return { platform: 'electron', start: 'npx electron . --remote-debugging-port=9222', cdpPort: 9222, notes };
  }

  const reactNative = deps.expo || deps['react-native'];
  const nativeIos = !existsSync(join(root, 'package.json')) && xcodeProjects(root).length > 0;
  const nativeAndroid = !existsSync(join(root, 'package.json')) && gradleFiles(root).length > 0;
  if (reactNative || nativeIos || nativeAndroid) {
    const platform = nativeIos ? 'ios' : nativeAndroid ? 'android' : mobilePlatform(root);
    notes.push(
      `Platform ${platform}: detected from ${reactNative ? 'package.json' : platform === 'ios' ? 'the Xcode project' : 'the Gradle files'}.`,
    );
    const id = detectAppId(root, platform);
    if (id) notes.push(`App ID ${id.appId}: detected from ${id.source}.`);
    else notes.push('App ID: not found. Enter the bundle ID or the package name.');
    // A native app has no dev server: the user installs it on the device.
    const start = deps.expo ? 'npx expo start' : deps['react-native'] ? 'npx react-native start' : undefined;
    if (!start) notes.push('Install the app on the simulator or the emulator before you run Bugpatrol.');
    return { platform, start, appId: id?.appId, notes };
  }

  const stack = detectStack(root);
  const best = detectBringUp(root)[0];
  if (best) notes.push(`Start command: detected from ${best.source}.`);
  const { port, source } = detectPort(root, pkg, stack.framework);
  notes.push(`Port ${port}: from ${source}.`);
  const ready = stack.framework ? FRAMEWORK_READY[stack.framework] : undefined;
  return { platform: 'web', start: best?.command, url: `http://localhost:${port}`, ready, notes };
}

export type InitAnswers = {
  platform: Platform;
  /** The command that starts the app. Empty: the user starts it. */
  start?: string;
  url?: string;
  appId?: string;
  cdpPort?: number;
  ready?: string;
  providers: Record<AgentRole, Provider>;
  /** Add --perm yolo to pi, for installs that have pi-permission-modes. */
  piPermissionModes?: boolean;
};

const READY: Record<Platform, string> = {
  desktop: 'ready|Ready|listening',
  api: 'ready|Uvicorn running on|listening',
  web: 'https?://(localhost|127\\.0\\.0\\.1)',
  electron: 'DevTools listening',
  ios: 'Waiting on http|Metro waiting|Dev server ready',
  android: 'Waiting on http|Metro waiting|Dev server ready',
};

function quoteYaml(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function useLine(role: AgentRole, provider: Provider, piPermissionModes = false): string {
  if (provider in KEY_PROVIDERS) {
    const route = KEY_PROVIDERS[provider as KeyProvider];
    return `{ runtime: model, via: ${provider}, model: ${route.model} }`;
  }
  if (provider === 'pi' && piPermissionModes) {
    const command = cliPreset('pi', role).replace('pi -p --no-session', 'pi -p --no-session --perm yolo');
    return `{ runtime: cli, command: ${quoteYaml(command)} }`;
  }
  return provider;
}

/** The starter bugpatrol.yml. Every value that init could not know has a comment. */
export function renderConfig(answers: InitAnswers): string {
  const { platform } = answers;
  const lines = [
    'version: 1',
    '',
    `# Written by \`bugpatrol init\` on ${new Date().toISOString().slice(0, 10)}. Correct any value that is wrong.`,
    '# Docs: https://github.com/agent-labs-dev/bugpatrol/blob/main/docs/configuration.md',
    '',
    'app:',
    `  platform: ${platform}`,
    '# Paths are relative to the project root: the folder that holds .bugpatrol/.',
    '  source: .                          # the repo that the fixer edits',
  ];
  if (answers.start) {
    lines.push(
      '  setup:',
      `    - run: ${quoteYaml(answers.start)}`,
      '      background: true               # keep the app alive for the session',
      `      readyWhen: ${quoteYaml(answers.ready ?? READY[platform])}   # start when the output matches`,
      `      timeoutMs: ${platform === 'web' ? 120000 : 180000}`,
    );
  } else {
    lines.push('  setup: []                          # empty: start the app yourself before you run Bugpatrol');
  }
  lines.push('  connect:');
  if (platform === 'web' || platform === 'api') lines.push(`    url: ${answers.url ?? 'http://localhost:3000'}`);
  if (platform === 'desktop')
    lines.push(
      '    cua:',
      '      launch: /absolute/path/to/app',
      '      args: []',
      '      viewer:',
      '        allowTakeover: false',
    );
  if (platform === 'electron')
    lines.push(`    cdp: http://127.0.0.1:${answers.cdpPort ?? 9222}   # the app must open this CDP port`);
  if (platform === 'ios' || platform === 'android') {
    lines.push(
      `    appId: ${answers.appId ?? 'com.example.app'}${answers.appId ? '' : '   # TODO: your bundle ID or package name'}`,
    );
    lines.push('    # device: <simulator UDID or emulator serial>   # default: the booted one');
  }
  lines.push(
    '  instructions: .bugpatrol/instructions.md   # plain English for the explorer: sign in, main flows, never-do list',
    '  secrets: []                        # env var names the explorer may use as {{NAME}}, e.g. [TEST_PASSWORD]',
    '',
    '# Each agent runs on an LLM: a local agent CLI (claude, codex, kimi, pi) or an API key.',
    'agents:',
    '  explorer:                          # uses the app and reports what looks wrong',
    `    use: ${useLine('explorer', answers.providers.explorer, answers.piPermissionModes)}`,
    '  judge:                             # decides which reports are real bugs, and writes the issues',
    `    use: ${useLine('judge', answers.providers.judge, answers.piPermissionModes)}`,
    '  fixer:                             # writes a fix in its own git worktree',
    '    enabled: false                   # turn on when you want Bugpatrol to fix bugs',
    `    use: ${useLine('fixer', answers.providers.fixer, answers.piPermissionModes)}`,
    '  github:',
    '    enabled: false                   # turn on to open PRs and issues (needs the gh CLI)',
    '',
  );
  return lines.join('\n');
}

const INSTRUCTIONS = `# About the app

<!-- One or two sentences: what the app is, and its main areas. -->

## Sign in

<!-- How the explorer signs in. Use {{NAME}} for secrets, and list NAME in app.secrets.
Example: Sign in with the email {{TEST_EMAIL}} and the password {{TEST_PASSWORD}}. -->

## Important flows

<!-- The flows that matter most. -->

## Never do these things

- Do not delete data that you did not make.
- Do not send email or messages to real people.
- Do not make payments.
`;

/**
 * Git-ignores the local data, and only the local data: the config, the app
 * guide, the app map and the routines in .bugpatrol/ are committed. A line
 * from an older version that ignores all of .bugpatrol/ is changed to the
 * data folder. True when the file changed.
 */
function ignoreData(root: string): boolean {
  const gitignore = join(root, '.gitignore');
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const lines = ignored.split('\n');
  // A repo from before the rename keeps .bughunters/, and its ignore line.
  const { dir } = layout(root);
  const line = `${dir}/${DATA_DIR}/`;
  if (lines.some((each) => new RegExp(`^/?\\${dir}/${DATA_DIR}/?$`).test(each.trim()))) return false;
  const whole = lines.findIndex((each) => new RegExp(`^/?\\${dir}/?$`).test(each.trim()));
  if (whole >= 0) {
    lines[whole] = line;
    writeFileSync(gitignore, lines.join('\n'));
    return true;
  }
  appendFileSync(
    gitignore,
    `${ignored && !ignored.endsWith('\n') ? '\n' : ''}# Bugpatrol: local data and screenshots of the real app\n${line}\n`,
  );
  return true;
}

export type InitResult = { written: string[]; skipped: string[]; warnings: string[] };

/** The config path to show: relative to the current folder when that is shorter. */
function relativeConfig(root: string): string {
  const shown = relative(process.cwd(), paths.config(root));
  return shown && !shown.startsWith('..') ? shown : paths.config(root);
}

/**
 * Writes .bugpatrol/bugpatrol.yml, .bugpatrol/instructions.md, and the
 * .gitignore line for .bugpatrol/runs/. Never overwrites a file.
 */
export function writeInitialConfig(root: string, answers: InitAnswers): InitResult {
  const result: InitResult = { written: [], skipped: [], warnings: [] };
  mkdirSync(paths.dir(root), { recursive: true });
  const configPath = paths.config(root);
  const configName = `${BUGPATROL_DIR}/${CONFIG_FILENAME}`;
  if (existsSync(configPath)) result.skipped.push(configName);
  else {
    writeFileSync(configPath, renderConfig(answers));
    result.written.push(configName);
  }
  const guidePath = join(paths.dir(root), 'instructions.md');
  if (existsSync(guidePath)) result.skipped.push(`${BUGPATROL_DIR}/instructions.md`);
  else {
    writeFileSync(guidePath, INSTRUCTIONS);
    result.written.push(`${BUGPATROL_DIR}/instructions.md`);
  }
  if (ignoreData(root)) result.written.push('.gitignore');

  for (const provider of new Set(Object.values(answers.providers))) {
    if (provider in KEY_PROVIDERS && !process.env[KEY_PROVIDERS[provider as KeyProvider].env]) {
      const route = KEY_PROVIDERS[provider as KeyProvider];
      result.warnings.push(`Set ${route.env} before you run Bugpatrol. Get a key at ${route.url}`);
    }
  }
  return result;
}

export type InitFlags = {
  yes: boolean;
  gate: boolean;
  platform?: Platform;
  start?: string;
  url?: string;
  appId?: string;
  agent?: Provider;
  explorer?: Provider;
  judge?: Provider;
  fixer?: Provider;
};

const PROVIDERS: Provider[] = [...CLI_AGENTS, ...(Object.keys(KEY_PROVIDERS) as KeyProvider[])];

export function parseInitFlags(args: string[]): InitFlags {
  const flags: InitFlags = { yes: false, gate: false };
  const oneOf = <T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T => {
    if (!value || !allowed.includes(value as T)) throw new ConfigError(`${flag} needs one of: ${allowed.join(', ')}`);
    return value as T;
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    const value = () => {
      const next = args[++index];
      if (next === undefined || next.startsWith('--')) throw new ConfigError(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '--yes':
      case '-y':
        flags.yes = true;
        break;
      case '--gate':
        flags.gate = true;
        break;
      case '--platform':
        flags.platform = oneOf(flag, args[++index], PLATFORMS);
        break;
      case '--start':
        flags.start = value();
        break;
      case '--url':
        flags.url = value();
        break;
      case '--app-id':
        flags.appId = value();
        break;
      case '--agent':
      case '--explorer':
      case '--judge':
      case '--fixer':
        flags[flag.slice(2) as 'agent' | AgentRole] = oneOf(flag, args[++index], PROVIDERS);
        break;
      default:
        throw new ConfigError(`Unknown flag for init: ${flag}`);
    }
  }
  return flags;
}

/** Detected CLIs first (no key to paste), then detected keys, then OpenRouter and Vercel as keys to get. */
export function providerOptions(detected: Detected): { value: Provider; label: string }[] {
  const options: { value: Provider; label: string }[] = [];
  for (const cli of detected.clis) options.push({ value: cli, label: `${CLI_LABELS[cli]} (installed)` });
  for (const key of detected.keys)
    options.push({ value: key, label: `${KEY_PROVIDERS[key].label} API key (${KEY_PROVIDERS[key].env} is set)` });
  for (const key of ['openrouter', 'vercel'] as const) {
    if (!detected.keys.includes(key)) {
      options.push({ value: key, label: `${KEY_PROVIDERS[key].label} API key (get one at ${KEY_PROVIDERS[key].url})` });
    }
  }
  return options;
}

export function defaultAnswers(guess: AppGuess, detected: Detected, flags: InitFlags): InitAnswers {
  const platform = flags.platform ?? guess.platform;
  const fallback = flags.agent ?? detected.clis[0] ?? detected.keys[0];
  const providers = {
    explorer: flags.explorer ?? fallback,
    judge: flags.judge ?? fallback,
    // The fixer edits code: a local agent CLI does that best.
    fixer: flags.fixer ?? flags.agent ?? detected.clis[0] ?? fallback,
  };
  const missing = (Object.keys(providers) as AgentRole[]).filter((role) => !providers[role]);
  if (missing.length) {
    throw new ConfigError(
      [
        'Bugpatrol needs an LLM for each agent, and it found none on this machine.',
        'Install an agent CLI (claude, codex, kimi, or pi), or set an API key:',
        `  OpenRouter:        export OPENROUTER_API_KEY=...   (${KEY_PROVIDERS.openrouter.url})`,
        `  Vercel AI Gateway: export AI_GATEWAY_API_KEY=...   (${KEY_PROVIDERS.vercel.url})`,
        'Or name one: bugpatrol init --agent claude',
      ].join('\n'),
    );
  }
  return {
    platform,
    start: flags.start ?? (platform === guess.platform ? guess.start : undefined),
    url: flags.url ?? guess.url,
    appId: flags.appId ?? guess.appId,
    cdpPort: guess.cdpPort,
    ready: platform === guess.platform ? guess.ready : undefined,
    providers: providers as Record<AgentRole, Provider>,
    piPermissionModes: detected.piPermissionModes,
  };
}

/** Asks one question. `prefill` goes on the input line, so the user presses Enter or edits it. */
type Ask = (question: string, prefill?: string) => Promise<string>;

async function choose<T extends string>(
  ask: Ask,
  title: string,
  options: { value: T; label: string }[],
  fallback: T,
): Promise<T> {
  const start = Math.max(
    0,
    options.findIndex((option) => option.value === fallback),
  );
  process.stdout.write(`\n${title}\n`);
  for (const [index, option] of options.entries()) {
    process.stdout.write(`  ${index + 1}) ${option.label}${index === start ? '  [default]' : ''}\n`);
  }
  for (;;) {
    const answer = (await ask(`Choose 1-${options.length}: `, String(start + 1))).trim();
    if (!answer) return options[start]!.value;
    const picked = options[Number(answer) - 1];
    if (picked) return picked.value;
  }
}

/** An empty answer means "none": the user cleared the detected value. */
async function text(ask: Ask, question: string, prefill?: string): Promise<string | undefined> {
  return (await ask(`${question}: `, prefill)).trim() || undefined;
}

/** Asks for each value, with the detected guess as the default. */
export async function interview(
  ask: Ask,
  root: string,
  guess: AppGuess,
  detected: Detected,
  answers: InitAnswers,
): Promise<InitAnswers> {
  if (guess.notes.length) {
    process.stdout.write('\nBugpatrol looked at the repo:\n');
    for (const note of guess.notes) process.stdout.write(`  ${note}\n`);
  }
  const platform = await choose(
    ask,
    'Which kind of app is it?',
    PLATFORMS.map((value) => ({ value, label: value === guess.platform ? `${value} (detected)` : value })),
    answers.platform,
  );
  const next: InitAnswers = { ...answers, platform, start: platform === guess.platform ? answers.start : undefined };
  process.stdout.write('\nPress Enter to keep a value, or edit it.\n');
  next.start = await text(ask, 'Start command (clear it if you start the app yourself)', next.start);
  if (platform === 'web' || platform === 'api')
    next.url = (await text(ask, 'App URL', next.url ?? 'http://localhost:3000')) ?? 'http://localhost:3000';
  if (platform === 'electron')
    next.cdpPort = Number(await text(ask, 'CDP port that the app opens', String(next.cdpPort ?? 9222))) || 9222;
  if (platform === 'ios' || platform === 'android') {
    const id = platform === guess.platform ? next.appId : detectAppId(root, platform)?.appId;
    next.appId = await text(ask, platform === 'ios' ? 'Bundle ID' : 'Package name', id);
  }

  const options = providerOptions(detected);
  process.stdout.write(
    '\nEach agent runs on an LLM. A local agent CLI uses your existing login, so you need no API key.\n',
  );
  if (!detected.clis.length && !detected.keys.length) {
    process.stdout.write(
      'Bugpatrol found no agent CLI and no API key. Get an OpenRouter or a Vercel AI Gateway key, then set it in your shell.\n',
    );
  }
  if (detected.piWithoutMcp)
    process.stdout.write('pi is installed, but it has no MCP. To use it, run: pi install npm:pi-mcp-adapter\n');
  next.providers = { ...next.providers };
  next.providers.explorer = await choose(
    ask,
    'Explorer: it uses the app and reports what looks wrong.',
    options,
    next.providers.explorer,
  );
  next.providers.judge = await choose(
    ask,
    'Judge: it decides which reports are real bugs.',
    options,
    next.providers.explorer,
  );
  next.providers.fixer = await choose(
    ask,
    'Fixer: it writes the fixes (off until you turn it on).',
    options,
    next.providers.fixer,
  );

  return next;
}

/** `bugpatrol init`: interactive in a terminal; `--yes` (or no terminal) takes the detected defaults. */
export async function runInit(root: string, args: string[], log: (line: string) => void): Promise<void> {
  const flags = parseInitFlags(args);
  if (flags.gate) {
    const result = writeGateConfig(root);
    log(`Wrote ${result.configPath}`);
    if (result.stack.framework) log(`Detected ${result.stack.framework}`);
    for (const note of result.notes) log(`  note: ${note}`);
    log('\nNext: review the TODO markers, then run `bugpatrol doctor`.');
    return;
  }
  if (existsSync(paths.config(root))) {
    throw new ConfigError(`${relativeConfig(root)} already exists. Edit it, or delete it and run init again.`);
  }
  const legacy = legacyLayout(root);
  if (legacy) throw new ConfigError(legacy);
  const guess = detectApp(root);
  const detected = detectProviders();
  const interactive = !flags.yes && process.stdin.isTTY && process.stdout.isTTY;
  let answers: InitAnswers;
  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const seed = safeDefaults(guess, detected, flags);
      answers = await interview(
        (question, prefill) => {
          const answer = rl.question(question);
          if (prefill) rl.write(prefill);
          return answer;
        },
        root,
        guess,
        detected,
        seed,
      );
    } finally {
      rl.close();
    }
  } else {
    answers = defaultAnswers(guess, detected, flags);
  }
  const result = writeInitialConfig(root, answers);
  for (const file of result.written) log(`Wrote ${file}`);
  for (const file of result.skipped) log(`Kept ${file}: it already exists`);
  if (!interactive) {
    // A value from a flag was not detected: do not say that it was.
    const given: Array<[unknown, string]> = [
      [flags.platform, 'Platform'],
      [flags.start, 'Start command'],
      [flags.url, 'Port'],
      [flags.appId, 'App ID'],
    ];
    for (const note of guess.notes) {
      if (!given.some(([value, prefix]) => value !== undefined && note.startsWith(prefix))) log(`  ${note}`);
    }
  }
  for (const warning of result.warnings) log(`  warning: ${warning}`);
  log('\nNext steps:');
  log(
    '  1. Check .bugpatrol/bugpatrol.yml, and write .bugpatrol/instructions.md: what the app is, how to sign in, and what never to do.',
  );
  log(
    '  2. Test the launch and the sign-in: `npx bugpatrol explore --steps 10 --goal "Sign in, then open the main screen"`',
  );
  log('  3. Start the patrol: `npx bugpatrol`. Watch it on `npx bugpatrol dashboard` (http://127.0.0.1:4311).');
}

/** Interactive mode may start with no provider: the user picks one from the list. */
function safeDefaults(guess: AppGuess, detected: Detected, flags: InitFlags): InitAnswers {
  try {
    return defaultAnswers(guess, detected, flags);
  } catch {
    return defaultAnswers(guess, detected, { ...flags, agent: flags.agent ?? 'openrouter' });
  }
}

/**
 * `bugpatrol init --gate`: bugpatrol.yml for the deterministic web gate,
 * with detected defaults and a TODO marker on anything it could not determine.
 * Detection is a first guess, never a silent decision -- everything is written
 * to the file with its provenance so a human can see WHY a value was chosen
 * and correct it (spec, Phase 0).
 */
export function writeGateConfig(root: string): { configPath: string; stack: StackProfile; notes: string[] } {
  const stack = detectStack(root);
  const candidates = detectBringUp(root);
  const best = candidates[0];
  const notes: string[] = [];

  if (!best) notes.push('Could not detect a bring-up command. `run.command` is marked TODO.');
  if (!stack.framework) notes.push('Could not detect a framework. Source mapping will be weaker until this is set.');

  const config = `version: 1

# Written by \`bugpatrol init --gate\` on ${new Date().toISOString().slice(0, 10)}.
# Every value below is a DETECTED GUESS with its provenance in a comment.
# Correct anything that is wrong; Bugpatrol will not overwrite your edits.

run:
  ${best ? `command: ${best.command}   # detected from ${best.source} (rung: ${best.rung})` : 'command: TODO   # could not detect - set this'}
  url: http://localhost:3000   # TODO confirm the port
  ready:
    # "The port is open" is not sufficient - plenty of apps serve a 200 error page.
    selectors: []              # TODO add a selector that only exists once the app booted
    forbidConsoleErrors: true
    timeoutMs: 60000
  seeds: []

auth:
  kind: none                   # none | form | storageState | seededUser | ssoBypass | manual

viewports:
  - { name: desktop, width: 1440, height: 900 }
  - { name: mobile,  width: 390,  height: 844 }

scope:
  include: ["src/**", "app/**"]
  ignore:  ["**/*.stories.tsx", "**/*.test.ts", "**/generated/**"]

crawl:
  maxScreens: 500
  maxDepth: 6
  maxActionsPerScreen: 15
  allowDestructive: false
  safeMode: true

mask: []

tolerance:
  # Exact by default, per-region overrides only. There is deliberately no
  # global threshold knob: every tool that ships one has a user who turned it
  # up until the build went green and it stopped catching anything.
  default: exact
  regions: []

determinism:
  image: ""                    # TODO pin by digest, e.g. ghcr.io/agent-labs-dev/bugpatrol-runner@sha256:...
  freezeClockAt: "2026-01-01T00:00:00.000Z"
  timezone: UTC
  locale: en-US
  failOnFontFallback: true
  blockThirdPartyRequests: true

decisions:
  model:
    via: auto                  # auto | openrouter | vercel | openai | anthropic | custom
    name: ""                   # optional model id override
  confidence: { high: 0.85, low: 0.55 }
  budget:
    perRunUsd: 0.50
    visionSampleRate: 0.05
    allowFrontier: true

surfaces:
  checks: true
  prComment: true
  issues: true
  questions: true
  fixPRs: false                # opt-in; this is the only thing that needs contents:write

production:
  detect: true
  allowMutations: false        # never enable against a production system
`;

  const configPath = paths.config(root);
  mkdirSync(paths.dir(root), { recursive: true });
  if (!existsSync(configPath)) writeFileSync(configPath, config);
  else notes.push(`${relativeConfig(root)} already exists and was left untouched.`);

  return { configPath, stack, notes };
}
