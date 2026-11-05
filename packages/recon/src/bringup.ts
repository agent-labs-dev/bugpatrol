import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecipeResolution, StackProfile } from '@bugpatrol/core';

export type BringUpCandidate = {
  command: string;
  rung: RecipeResolution;
  /** Which file implied this. Detection is a first guess, never silent. */
  source: string;
  confidence: number;
  /** The app folder the command runs in, relative to the root. Undefined: the root. */
  cwd?: string;
};

/** Folders that commonly hold the web app of a repo whose root is something else. */
const APP_DIRS = ['frontend', 'web', 'client', 'site', 'apps/web'];

/** Runs `script` of the package in `dir` from the root, with the folder's package manager. */
function scriptCommand(root: string, dir: string | undefined, script: string): string {
  const manager = detectPackageManager(dir ? join(root, dir) : root, root);
  const run = script === 'start' ? 'start' : `run ${script}`;
  if (!dir) return `${manager} ${run}`;
  const flag = { npm: '--prefix', pnpm: '--dir', yarn: '--cwd', bun: '--cwd' }[manager];
  return `${manager} ${flag} ${dir} ${run}`;
}

/**
 * The bring-up ladder, cheapest rung first (spec 1.1). Rungs 1-3 are pure file
 * reading and cost nothing; rung 4 (docs) and rung 5 (agentic trial) are only
 * reached when the cheap rungs come up empty, and rung 5 is budget-capped so
 * Recon terminates predictably rather than burning tokens.
 */
export function detectBringUp(root: string): BringUpCandidate[] {
  const candidates: BringUpCandidate[] = [];

  // Rung 2: precedent -- the command CI already uses is the one that works.
  for (const workflow of listWorkflows(root)) {
    const content = readFileSync(workflow, 'utf8');
    const match = content.match(/run:\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(dev|start|preview|serve)\b/);
    if (match) {
      candidates.push({
        command: match[0].replace(/^run:\s*/, ''),
        rung: 'precedent',
        source: workflow,
        confidence: 0.8,
      });
    }
  }

  // Rung 3: convention. The repo's own scripts, at the root and then in an app folder.
  for (const dir of [undefined, ...APP_DIRS]) {
    const pkgPath = join(dir ? join(root, dir) : root, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as typeof pkg;
    } catch {
      continue;
    }
    for (const script of ['dev', 'start', 'preview', 'serve']) {
      if (pkg.scripts?.[script]) {
        candidates.push({
          command: scriptCommand(root, dir, script),
          rung: 'convention',
          source: dir ? `${dir}/package.json` : 'package.json',
          confidence: (script === 'dev' ? 0.7 : 0.5) - (dir ? 0.1 : 0),
          ...(dir ? { cwd: dir } : {}),
        });
      }
    }
  }
  // A compose file often describes the production stack, with its public
  // ports and real secrets: the last resort, after the repo's own scripts.
  const compose = COMPOSE_FILES.find((file) => existsSync(join(root, file)));
  if (compose) {
    candidates.push({ command: 'docker compose up', rung: 'convention', source: compose, confidence: 0.2 });
  }
  if (existsSync(join(root, 'Procfile'))) {
    candidates.push({ command: 'foreman start', rung: 'convention', source: 'Procfile', confidence: 0.3 });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

/** The package manager of the lockfile in `dir`, else in `fallback` (a workspace root). */
export function detectPackageManager(dir: string, fallback?: string): NonNullable<StackProfile['packageManager']> {
  for (const each of fallback && fallback !== dir ? [dir, fallback] : [dir]) {
    if (existsSync(join(each, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(each, 'bun.lockb')) || existsSync(join(each, 'bun.lock'))) return 'bun';
    if (existsSync(join(each, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(each, 'package-lock.json'))) return 'npm';
  }
  return 'npm';
}

/**
 * Stack detection, in order of reliability (spec, Phase 0). Everything detected
 * is written into the config with its provenance, so a human can see WHY a
 * value was chosen and correct it.
 */
export function detectStack(root: string): StackProfile {
  const detectedFrom: string[] = [];
  let framework: string | undefined;

  const signatures: Array<[string, string]> = [
    ['next.config.js', 'next'],
    ['next.config.ts', 'next'],
    ['next.config.mjs', 'next'],
    ['vite.config.ts', 'vite'],
    ['vite.config.js', 'vite'],
    ['angular.json', 'angular'],
    ['manage.py', 'django'],
    ['Gemfile', 'rails'],
    ['go.mod', 'go'],
    ['Cargo.toml', 'rust'],
    ['app.json', 'expo'],
  ];
  for (const [file, name] of signatures) {
    if (!existsSync(join(root, file))) continue;
    framework ??= name;
    detectedFrom.push(file);
  }

  const packageManager = detectPackageManager(root);
  detectedFrom.push(`${packageManager} lockfile`);

  return {
    framework,
    packageManager,
    detectedFrom,
    confidence: framework ? 0.8 : 0.3,
  };
}

function listWorkflows(root: string): string[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  try {
    // Intentionally shallow: CI workflows are not nested.
    return readdirSync(dir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}
