import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Everything Bugpatrol owns lives in one folder at the project root:
 *
 *   .bugpatrol/
 *     bugpatrol.yml      committed: the config
 *     instructions.md    committed: the app guide for the explorer
 *     runs/              gitignored: sessions, issues, fixes, worktrees, memory
 *
 * The gate's committed manifest is small, diffs cleanly, and makes a baseline
 * change reviewable in the pull request. The pixels live in content-addressed
 * object storage; putting them in git is what makes every CI clone pay (spec 12.1).
 *
 * A repo from before the rename to Bugpatrol has `.bughunters/bughunters.yml`,
 * and it keeps that folder: see layout().
 */
export const BUGPATROL_DIR = '.bugpatrol';
/** The gitignored part of BUGPATROL_DIR. */
export const DATA_DIR = 'runs';
export const CONFIG_FILENAME = 'bugpatrol.yml';
/** The folder and the config name from before the rename to Bugpatrol. A repo that has them keeps them. */
export const LEGACY_DIR = '.bughunters';
export const LEGACY_CONFIG_FILENAME = 'bughunters.yml';

/**
 * The folder and the config file of `root`: `.bugpatrol/bugpatrol.yml`, or
 * `.bughunters/bughunters.yml` in a repo that has only that one.
 */
export function layout(root: string): { dir: string; config: string } {
  if (
    !existsSync(join(root, BUGPATROL_DIR, CONFIG_FILENAME)) &&
    existsSync(join(root, LEGACY_DIR, LEGACY_CONFIG_FILENAME))
  ) {
    return { dir: LEGACY_DIR, config: LEGACY_CONFIG_FILENAME };
  }
  return { dir: BUGPATROL_DIR, config: CONFIG_FILENAME };
}

const dir = (root: string) => join(root, layout(root).dir);
const data = (root: string, ...parts: string[]) => join(dir(root), DATA_DIR, ...parts);

/**
 * A file-backed id is one path segment. Agents choose some ids (a screen id,
 * a routine id), so an id such as "../x" must not reach a path outside its folder.
 */
export function recordId(value: string): string {
  if (!value || value.length > 200 || value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new Error(`Invalid workspace record identifier: ${JSON.stringify(value.slice(0, 80))}`);
  }
  return value;
}

export const paths = {
  dir,
  /** Gitignored. All local output: nothing under it is committed. */
  data: (root: string) => data(root),
  /** Committed. */
  config: (root: string, configFile?: string) =>
    configFile ? resolve(root, configFile) : join(dir(root), layout(root).config),
  /** Committed. Human-reviewable. */
  appModel: (root: string) => join(dir(root), 'appmodel.json'),
  /** Committed. Hashes + image digest, NOT the pixels. */
  baselineManifest: (root: string) => join(dir(root), 'baselines.manifest.json'),
  /** Committed. Reviewable in PRs -- a ledger nobody can audit is a mute button. */
  intents: (root: string) => join(dir(root), 'intents.json'),
  /** The local pixel store behind the manifest. */
  baselines: (root: string) => data(root, 'baselines'),
  /** Gate run output. */
  runs: (root: string) => data(root, 'gate'),
  run: (root: string, runId: string) => data(root, 'gate', recordId(runId)),
  /** Progress for the gate run currently in flight. Rewritten per screen. */
  live: (root: string) => data(root, 'gate', 'live.json'),
  appMap: (root: string) => data(root, 'appmap.json'),
  /** What the judge already decided, by fingerprint, so a decided finding does not come back. */
  triage: (root: string) => data(root, 'triage.json'),
  memory: (root: string) => data(root, 'memory.json'),
  agentBaselines: (root: string) => data(root, 'agent-baselines'),
  agentBaseline: (root: string, id: string) => data(root, 'agent-baselines', `${recordId(id)}.png`),
  agentBaselineSnapshot: (root: string, id: string) => data(root, 'agent-baselines', `${recordId(id)}.snapshot.json`),
  worktrees: (root: string) => data(root, 'worktrees'),
  routines: (root: string) => data(root, 'routines'),
  routine: (root: string, id: string) => data(root, 'routines', `${recordId(id)}.json`),
  issues: (root: string) => data(root, 'issues'),
  issue: (root: string, id: string) => data(root, 'issues', `${recordId(id)}.json`),
  fixes: (root: string) => data(root, 'fixes'),
  fix: (root: string, id: string) => data(root, 'fixes', `${recordId(id)}.json`),
  publish: (root: string) => data(root, 'publish'),
  review: (root: string, pr: number) => data(root, 'reviews', `pr-${pr}.json`),
  sessions: (root: string) => data(root, 'sessions'),
  session: (root: string, id: string) => data(root, 'sessions', recordId(id)),
  agents: (root: string) => data(root, 'agents.json'),
  /** One session's collected logs, the signals it saw, and its merged flow. */
  sessionLogs: (root: string, id: string) => data(root, 'sessions', recordId(id), 'logs.json'),
  sessionSignals: (root: string, id: string) => data(root, 'sessions', recordId(id), 'signals.jsonl'),
  sessionFlow: (root: string, id: string) => data(root, 'sessions', recordId(id), 'flow.json'),
} as const;

/**
 * The project root: the nearest folder at or above `start` that holds
 * `.bugpatrol/bugpatrol.yml`, so a command works from any subfolder, the
 * way git does. With no config anywhere above, `start` itself.
 */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(paths.config(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/**
 * The app guide for the explorer: `app.instructions` when it is set, else
 * `.bugpatrol/instructions.md` when that file exists.
 */
export function instructionsPath(root: string, configured?: string): string | undefined {
  if (configured) return resolve(root, configured);
  const fallback = join(dir(root), 'instructions.md');
  return existsSync(fallback) ? fallback : undefined;
}

/**
 * Earlier versions kept bughunters.yml and instructions.md at the project root,
 * and the local data directly under `.bughunters/`. Returns how to move to the
 * current layout, or undefined when there is nothing old here.
 */
export function legacyLayout(root: string): string | undefined {
  if (!existsSync(join(root, LEGACY_CONFIG_FILENAME))) return undefined;
  return [
    `Bugpatrol now keeps its config in ${BUGPATROL_DIR}/. Run this command in ${root}:`,
    `  mkdir -p ${BUGPATROL_DIR} && mv ${LEGACY_CONFIG_FILENAME} ${BUGPATROL_DIR}/${CONFIG_FILENAME} && mv instructions.md ${BUGPATROL_DIR}/`,
    `Then remove the \`instructions:\` line from ${BUGPATROL_DIR}/${CONFIG_FILENAME}.`,
    `Bugpatrol now writes its local data in ${BUGPATROL_DIR}/${DATA_DIR}/. Add ${BUGPATROL_DIR}/${DATA_DIR}/ to .gitignore.`,
  ].join('\n');
}

export type BaselineManifest = {
  version: 1;
  /** Every entry was captured in this image. Changing it invalidates them all. */
  imageDigest: string;
  entries: Record<string, { sha256: string; viewport: string; bytes: number; capturedAt: string }>;
};
