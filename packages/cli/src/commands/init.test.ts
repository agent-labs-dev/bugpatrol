import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instructionsPath, loadConfig, parseConfig } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type Detected,
  defaultAnswers,
  detectApp,
  detectAppId,
  detectProviders,
  type InitAnswers,
  interview,
  parseInitFlags,
  providerOptions,
  renderConfig,
  writeGateConfig,
  writeInitialConfig,
} from './init.js';

function fixtureRepo(pkg: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'bugpatrol-init-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, ...pkg }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  writeFileSync(join(root, 'vite.config.ts'), '');
  mkdirSync(join(root, '.github'), { recursive: true });
  return root;
}

/** A PATH that holds only the named programs. */
function fakePath(...programs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bugpatrol-path-'));
  for (const program of programs) {
    writeFileSync(join(dir, program), '#!/bin/sh\n');
    chmodSync(join(dir, program), 0o755);
  }
  return dir;
}

const none: Detected = { clis: [], keys: [], piWithoutMcp: false, piPermissionModes: false };

const answers = (overrides: Partial<InitAnswers> = {}): InitAnswers => ({
  platform: 'web',
  start: 'pnpm run dev',
  url: 'http://localhost:5173',
  providers: { explorer: 'claude', judge: 'claude', fixer: 'claude' },
  ...overrides,
});

describe('detectApp', () => {
  it('guesses a web app, its start command, and its port', () => {
    const guess = detectApp(fixtureRepo());
    expect(guess).toMatchObject({ platform: 'web', start: 'pnpm run dev', url: 'http://localhost:5173' });
  });

  it('waits for the line that the framework prints when it is ready', () => {
    const root = fixtureRepo({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } });
    rmSync(join(root, 'vite.config.ts'));
    writeFileSync(join(root, 'next.config.ts'), '');
    const guess = detectApp(root);
    expect(guess.ready).toBe('Ready in|✓ Ready');
    const text = renderConfig({ ...answers(), ready: guess.ready });
    expect(parseConfig(parse(text)).app.setup[0]?.readyWhen).toBe('Ready in|✓ Ready');
  });

  it('reads an explicit port from the scripts', () => {
    expect(detectApp(fixtureRepo({ scripts: { dev: 'next dev -p 4000' } })).url).toBe('http://localhost:4000');
  });

  it('detects Electron and Expo from the dependencies', () => {
    expect(detectApp(fixtureRepo({ devDependencies: { electron: '1' } })).platform).toBe('electron');
    const root = fixtureRepo({ dependencies: { expo: '1' } });
    writeFileSync(
      join(root, 'app.json'),
      JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.acme.ios' }, android: { package: 'com.acme.android' } } }),
    );
    const guess = detectApp(root);
    expect(['ios', 'android']).toContain(guess.platform);
    expect(guess.appId).toBe(guess.platform === 'ios' ? 'com.acme.ios' : 'com.acme.android');
    expect(guess.start).toBe('npx expo start');
  });
});

describe('detectAppId', () => {
  it('reads app.config, the Xcode project, and the Gradle file', () => {
    const expo = fixtureRepo();
    writeFileSync(
      join(expo, 'app.config.ts'),
      "export default { ios: { bundleIdentifier: 'com.acme.cfg' }, android: { package: 'com.acme.droid' } }",
    );
    expect(detectAppId(expo, 'ios')).toEqual({ appId: 'com.acme.cfg', source: 'app.config.ts' });
    expect(detectAppId(expo, 'android')).toEqual({ appId: 'com.acme.droid', source: 'app.config.ts' });

    const native = mkdtempSync(join(tmpdir(), 'bugpatrol-native-'));
    mkdirSync(join(native, 'ios', 'Acme.xcodeproj'), { recursive: true });
    writeFileSync(
      join(native, 'ios', 'Acme.xcodeproj', 'project.pbxproj'),
      'PRODUCT_BUNDLE_IDENTIFIER = com.acme.AcmeTests;\nPRODUCT_BUNDLE_IDENTIFIER = com.acme.app;\n',
    );
    mkdirSync(join(native, 'android', 'app'), { recursive: true });
    writeFileSync(
      join(native, 'android', 'app', 'build.gradle.kts'),
      'android { defaultConfig { applicationId = "com.acme.android" } }',
    );
    expect(detectAppId(native, 'ios')?.appId).toBe('com.acme.app');
    expect(detectAppId(native, 'android')?.appId).toBe('com.acme.android');
  });

  it('detects a native Android app with no package.json, and reads a Vite port', () => {
    const native = mkdtempSync(join(tmpdir(), 'bugpatrol-native-'));
    mkdirSync(join(native, 'app'), { recursive: true });
    writeFileSync(join(native, 'app', 'build.gradle'), "defaultConfig { applicationId 'com.acme.plain' }");
    expect(detectApp(native)).toMatchObject({ platform: 'android', appId: 'com.acme.plain', start: undefined });

    const web = fixtureRepo();
    writeFileSync(join(web, 'vite.config.ts'), 'export default { server: { port: 4100 } }');
    expect(detectApp(web).url).toBe('http://localhost:4100');
  });
});

describe('detectProviders', () => {
  it('finds agent CLIs on PATH and keys in the environment', () => {
    const detected = detectProviders({ PATH: fakePath('claude', 'codex'), OPENROUTER_API_KEY: 'x' }, () => '');
    expect(detected.clis).toEqual(['claude', 'codex']);
    expect(detected.keys).toEqual(['openrouter']);
  });

  it('skips pi without pi-mcp-adapter, because the explorer needs MCP', () => {
    const PATH = fakePath('pi');
    expect(detectProviders({ PATH }, () => '').clis).toEqual([]);
    expect(detectProviders({ PATH }, () => '').piWithoutMcp).toBe(true);
    const withAdapter = detectProviders({ PATH }, () => 'npm:pi-mcp-adapter\nnpm:pi-permission-modes');
    expect(withAdapter.clis).toEqual(['pi']);
    expect(withAdapter.piPermissionModes).toBe(true);
  });
});

describe('defaultAnswers', () => {
  const guess = { platform: 'web' as const, start: 'pnpm run dev', url: 'http://localhost:5173', notes: [] };

  it('prefers an installed CLI over an API key', () => {
    const picked = defaultAnswers(guess, { ...none, clis: ['codex'], keys: ['openrouter'] }, parseInitFlags([]));
    expect(picked.providers).toEqual({ explorer: 'codex', judge: 'codex', fixer: 'codex' });
  });

  it('uses a detected key when there is no CLI', () => {
    const picked = defaultAnswers(guess, { ...none, keys: ['vercel'] }, parseInitFlags([]));
    expect(picked.providers.explorer).toBe('vercel');
  });

  it('requires at least one way to reach an LLM', () => {
    expect(() => defaultAnswers(guess, none, parseInitFlags([]))).toThrow(/needs an LLM/);
    expect(defaultAnswers(guess, none, parseInitFlags(['--agent', 'openrouter'])).providers.judge).toBe('openrouter');
  });

  it('lets each role use its own provider', () => {
    const picked = defaultAnswers(
      guess,
      { ...none, clis: ['claude'] },
      parseInitFlags(['--explorer', 'openrouter', '--fixer', 'codex']),
    );
    expect(picked.providers).toEqual({ explorer: 'openrouter', judge: 'claude', fixer: 'codex' });
  });
});

describe('providerOptions', () => {
  it('lists CLIs first, then set keys, then keys to get', () => {
    const options = providerOptions({ ...none, clis: ['claude'], keys: ['openai'] });
    expect(options.map((option) => option.value)).toEqual(['claude', 'openai', 'openrouter', 'vercel']);
    expect(options[2]!.label).toContain('https://openrouter.ai/keys');
  });
});

describe('renderConfig', () => {
  it.each([
    answers(),
    answers({ start: undefined }),
    answers({ platform: 'electron', start: 'npx electron . --remote-debugging-port=9222', cdpPort: 9222 }),
    answers({ platform: 'ios', start: 'npx expo start', appId: 'com.acme.app' }),
    answers({ platform: 'android', start: undefined, appId: undefined }),
    answers({ platform: 'cli', start: 'pnpm build' }),
    answers({ providers: { explorer: 'openrouter', judge: 'vercel', fixer: 'codex' } }),
    answers({ providers: { explorer: 'pi', judge: 'kimi', fixer: 'pi' }, piPermissionModes: true }),
  ])('writes a config that parses: %#', (input) => {
    expect(() => parseConfig(parse(renderConfig(input)))).not.toThrow();
  });

  it('builds a CLI app to its end, with no server to wait for', () => {
    const config = parseConfig(parse(renderConfig(answers({ platform: 'cli', start: 'pnpm build' }))));
    expect(config.app.platform).toBe('cli');
    expect(config.app.setup).toEqual([expect.objectContaining({ run: 'pnpm build', background: false })]);
    expect(config.app.connect.cli.timeoutMs).toBe(60_000);
  });

  it('expands CLI presets per role, and keeps the fixer off', () => {
    const config = parseConfig(parse(renderConfig(answers())));
    expect(config.agents.explorer.use).toMatchObject({
      runtime: 'cli',
      command: expect.stringContaining('--mcp-config {mcp}'),
    });
    expect(config.agents.fixer.use).toMatchObject({
      runtime: 'cli',
      command: 'claude -p --output-format json --permission-mode auto',
    });
    expect(config.agents.fixer.enabled).toBe(false);
    expect(config.agents.github.enabled).toBe(false);
    expect(renderConfig(answers())).not.toMatch(/jev|decisions/i);
  });

  it('writes a model route for an API key provider', () => {
    const config = parseConfig(
      parse(renderConfig(answers({ providers: { explorer: 'openrouter', judge: 'openrouter', fixer: 'claude' } }))),
    );
    expect(config.agents.explorer.use).toEqual({ runtime: 'model', via: 'openrouter', model: 'z-ai/glm-5.3-flash' });
  });

  it('adds --perm yolo to pi when pi-permission-modes would block its tools', () => {
    const config = parseConfig(
      parse(
        renderConfig(answers({ providers: { explorer: 'pi', judge: 'pi', fixer: 'pi' }, piPermissionModes: true })),
      ),
    );
    expect(config.agents.explorer.use).toMatchObject({ command: 'pi -p --no-session --perm yolo --mcp-config {mcp}' });
  });
});

describe('writeInitialConfig', () => {
  it('writes the config and the app guide in .bugpatrol/, and ignores only the local data', () => {
    const root = fixtureRepo();
    writeFileSync(join(root, '.gitignore'), 'node_modules');
    const result = writeInitialConfig(root, answers());
    expect(result.written).toEqual(['.bugpatrol/bugpatrol.yml', '.bugpatrol/instructions.md', '.gitignore']);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      'node_modules\n# Bugpatrol: local data and screenshots of the real app\n.bugpatrol/runs/\n',
    );
    expect(readFileSync(join(root, '.bugpatrol', 'instructions.md'), 'utf8')).toContain('Never do these things');
    expect(existsSync(join(root, 'bugpatrol.yml'))).toBe(false);
    const config = loadConfig(root);
    expect(instructionsPath(root, config.app.instructions)).toBe(join(root, '.bugpatrol', 'instructions.md'));
  });

  it('ignores the run directory and keeps routines and the app map committable', () => {
    const root = fixtureRepo();
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeInitialConfig(root, answers());
    const ignored = (path: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', path], { cwd: root });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('.bugpatrol/runs/sessions/ses_1/001-home.png')).toBe(true);
    expect(ignored('.bugpatrol/routines/enter-app.json')).toBe(false);
    expect(ignored('.bugpatrol/appmap.json')).toBe(false);
  });

  it('never overwrites a file, and adds the .gitignore line once', () => {
    const root = fixtureRepo();
    mkdirSync(join(root, '.bugpatrol'));
    writeFileSync(join(root, '.bugpatrol', 'bugpatrol.yml'), '# mine\n');
    writeFileSync(join(root, '.bugpatrol', 'instructions.md'), '# mine\n');
    writeFileSync(join(root, '.gitignore'), '.bugpatrol/runs/\n');
    const result = writeInitialConfig(root, answers());
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['.bugpatrol/bugpatrol.yml', '.bugpatrol/instructions.md']);
    expect(readFileSync(join(root, '.bugpatrol', 'bugpatrol.yml'), 'utf8')).toBe('# mine\n');
  });

  it('changes an old line that ignores all of .bugpatrol/, so the config is committed', () => {
    const root = fixtureRepo();
    writeFileSync(join(root, '.gitignore'), 'dist\n.bugpatrol/\n.env\n');
    writeInitialConfig(root, answers());
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('dist\n.bugpatrol/runs/\n.env\n');
  });

  it('warns about a key that the config needs and the shell does not have', () => {
    const result = writeInitialConfig(
      fixtureRepo(),
      answers({ providers: { explorer: 'openrouter', judge: 'openrouter', fixer: 'openrouter' } }),
    );
    expect(result.warnings.join('\n')).toContain('OPENROUTER_API_KEY');
  });
});

describe('interview', () => {
  const guess = { platform: 'web' as const, start: 'npm run dev', url: 'http://localhost:5173', notes: [] };
  const detected: Detected = { ...none, clis: ['claude', 'codex'] };

  /** Plays the user: each reply gets the prefilled value, and returns what the user leaves on the line. */
  async function play(replies: ((prefill: string) => string)[]) {
    const prompts: { question: string; prefill?: string }[] = [];
    const ask = async (question: string, prefill?: string) => {
      prompts.push({ question, prefill });
      return (replies.shift() ?? ((p: string) => p))(prefill ?? '');
    };
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const result = await interview(
        ask,
        fixtureRepo(),
        guess,
        detected,
        defaultAnswers(guess, detected, parseInitFlags([])),
      );
      return { result, prompts, replies };
    } finally {
      process.stdout.write = write;
    }
  }
  const enter = (prefill: string) => prefill;

  it('puts each detected value on the input line, so Enter keeps it', async () => {
    const { result, prompts } = await play([]);
    expect(prompts.map((prompt) => prompt.prefill)).toEqual([
      '1',
      'npm run dev',
      'http://localhost:5173',
      '1',
      '1',
      '1',
    ]);
    expect(result).toMatchObject({
      platform: 'web',
      start: 'npm run dev',
      url: 'http://localhost:5173',
      providers: { explorer: 'claude', judge: 'claude', fixer: 'claude' },
    });
  });

  it('takes an edited value, a cleared value, and a different number', async () => {
    const { result, replies } = await play([enter, () => 'pnpm dev', enter, () => '2', enter, enter]);
    expect(result).toMatchObject({
      start: 'pnpm dev',
      providers: { explorer: 'codex', judge: 'codex', fixer: 'claude' },
    });
    expect(replies).toEqual([]);
    expect((await play([enter, () => ''])).result.start).toBeUndefined();
  });
});

describe('parseInitFlags', () => {
  it('rejects unknown flags and providers', () => {
    expect(() => parseInitFlags(['--bogus'])).toThrow(/Unknown flag/);
    expect(() => parseInitFlags(['--agent', 'gemini'])).toThrow(/claude, codex, kimi, pi/);
  });
});

describe('writeGateConfig', () => {
  it('writes a gate config that parses, with conservative defaults and no workflow', () => {
    const root = fixtureRepo();
    const { configPath, stack } = writeGateConfig(root);
    const text = readFileSync(configPath, 'utf8');
    const config = parseConfig(parse(text));
    expect(stack.framework).toBe('vite');
    expect(text).toContain('pnpm run dev');
    expect(config.surfaces.fixPRs).toBe(false);
    expect(config.production.allowMutations).toBe(false);
    expect(config.tolerance.default).toBe('exact');
    expect(() => readFileSync(join(root, '.github', 'workflows', 'bugpatrol.yml'))).toThrow();
  });

  it('marks what it could not determine with TODO rather than guessing silently', () => {
    const { configPath, notes } = writeGateConfig(fixtureRepo({ scripts: {} }));
    expect(readFileSync(configPath, 'utf8')).toContain('TODO');
    expect(notes.join(' ')).toContain('bring-up command');
  });
});
