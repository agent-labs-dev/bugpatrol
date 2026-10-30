import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { paths, STATE_FILES } from '@bugpatrol/core';

const exec = promisify(execFile);

/** The branch that `agents.patrol.state: branch` shares. */
export const STATE_BRANCH = 'bugpatrol-state';
const REMOTE = 'origin';
/** Push attempts before a push that keeps losing the race fails. */
const PUSH_ATTEMPTS = 5;

/** The state files, by their path in the Bugpatrol folder, as JSON text. */
type Files = Map<string, string>;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: env && { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const patterns = STATE_FILES.map(
  (entry) => [entry, new RegExp(`^${entry.path.replaceAll('.', '\\.').replace('*', '[^/]+')}$`)] as const,
);

/** The STATE_FILES entry that allows `path`, or undefined when nothing allows it. */
function entryFor(path: string): (typeof STATE_FILES)[number] | undefined {
  return patterns.find(([, pattern]) => pattern.test(path))?.[0];
}

function parse(path: string, text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The state file ${path} (${where}) is not valid JSON: ${(error as Error).message}. Fix or delete it; nothing was overwritten.`,
    );
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function pick(value: unknown, keys: readonly string[]): Json {
  const out: Json = {};
  for (const key of keys) {
    const parts = key.split('.');
    let source: unknown = value;
    for (const part of parts) source = isRecord(source) ? source[part] : undefined;
    if (source === undefined) continue;
    let target = out;
    for (const part of parts.slice(0, -1)) {
      target[part] ??= {};
      target = target[part] as Json;
    }
    target[parts.at(-1)!] = source;
  }
  return out;
}

/** Writes the fields of `shared` into `full`, and keeps every other field of `full`. */
function place(full: Json, shared: Json): Json {
  const out = { ...full };
  for (const [key, value] of Object.entries(shared)) {
    out[key] = isRecord(value) && isRecord(out[key]) ? place(out[key] as Json, value) : value;
  }
  return out;
}

const hasIds = (items: unknown[]): items is Json[] =>
  items.every((item) => isRecord(item) && typeof item.id === 'string');

/**
 * Three-way merge of one JSON value. A side that did not change from `base`
 * takes the other side. Objects merge by key and lists of records merge by
 * `id`, so two writers keep both new issues, lessons, and screens. Other
 * lists keep the items of both sides, so no retest or attempt is lost. When
 * both sides changed a scalar, this writer (`ours`) wins. `undefined` means
 * absent: a record that one side removed and the other did not change stays
 * removed.
 */
function mergeState(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (isDeepStrictEqual(ours, theirs)) return ours;
  if (isDeepStrictEqual(base, ours)) return theirs;
  if (isDeepStrictEqual(base, theirs)) return ours;
  if (isRecord(ours) && isRecord(theirs)) {
    const from = isRecord(base) ? base : {};
    const out: Json = {};
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const value = mergeState(from[key], ours[key], theirs[key]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    if (hasIds(ours) && hasIds(theirs)) {
      const byId = (items: unknown) =>
        new Map(Array.isArray(items) && hasIds(items) ? items.map((item) => [item.id as string, item]) : []);
      const [was, mine, other] = [byId(base), byId(ours), byId(theirs)];
      return [...new Set([...mine.keys(), ...other.keys()])]
        .map((id) => mergeState(was.get(id), mine.get(id), other.get(id)))
        .filter((item) => item !== undefined);
    }
    const key = (item: unknown) => JSON.stringify(item);
    const removed = new Set((Array.isArray(base) ? base : []).map(key));
    for (const item of ours) removed.delete(key(item));
    const seen = new Set(ours.map(key));
    return [...ours, ...theirs.filter((item) => !seen.has(key(item)) && !removed.has(key(item)))];
  }
  return ours;
}

/** The shared view of the local state files: what this machine would put on the branch. */
async function readLocal(root: string): Promise<{ shared: Files; full: Files }> {
  const dir = paths.dir(root);
  const shared: Files = new Map();
  const full: Files = new Map();
  const read = async (path: string) => {
    try {
      return await readFile(join(dir, path), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  for (const entry of STATE_FILES) {
    let names = [entry.path];
    if (entry.path.endsWith('/*.json')) {
      const folder = dirname(entry.path);
      try {
        names = (await readdir(join(dir, folder)))
          .map((name) => `${folder}/${name}`)
          .filter((path) => entryFor(path) === entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        names = [];
      }
    }
    for (const path of names.sort()) {
      const text = await read(path);
      if (text === undefined) continue;
      full.set(path, text);
      shared.set(path, entry.keys ? json(pick(parse(path, text, 'local'), entry.keys)) : text);
    }
  }
  return { shared, full };
}

/** The state files in a branch commit. A file outside STATE_FILES on the branch is ignored. */
async function readCommit(root: string, commit: string): Promise<Files> {
  const listing = await git(root, ['ls-tree', '-r', '-z', commit]);
  const files: Files = new Map();
  for (const line of listing.split('\0').filter(Boolean)) {
    const [meta, path] = line.split('\t') as [string, string];
    if (!entryFor(path) || !meta.includes(' blob ')) continue;
    files.set(path, await git(root, ['cat-file', 'blob', meta.split(' ')[2]!]));
  }
  return files;
}

async function readBase(root: string, branch: string): Promise<Files> {
  try {
    const saved = JSON.parse(await readFile(paths.stateBase(root), 'utf8')) as { branch: string; commit: string };
    if (saved.branch === branch) return await readCommit(root, saved.commit);
  } catch {
    // No base yet, or git dropped its commit: every difference is new on both sides.
  }
  return new Map();
}

async function saveBase(root: string, branch: string, commit: string): Promise<void> {
  await mkdir(dirname(paths.stateBase(root)), { recursive: true });
  await writeFile(paths.stateBase(root), json({ branch, commit }));
}

/** The commit at the tip of the remote branch, or undefined when the branch does not exist yet. */
async function fetchTip(root: string, branch: string): Promise<string | undefined> {
  try {
    await git(root, ['fetch', '-q', REMOTE, `refs/heads/${branch}`]);
  } catch (error) {
    if (/couldn't find remote ref/i.test((error as { stderr?: string }).stderr ?? '')) return undefined;
    throw error;
  }
  return (await git(root, ['rev-parse', 'FETCH_HEAD'])).trim();
}

/**
 * Merges the files of `tip` into the local state files. It merges every file
 * before it writes one, so a file it cannot merge changes nothing.
 */
async function mergeLocal(root: string, branch: string, tip: string): Promise<number> {
  const [base, theirs, local] = [await readBase(root, branch), await readCommit(root, tip), await readLocal(root)];
  const writes: [string, string][] = [];
  for (const [path, text] of theirs) {
    const ours = local.shared.get(path);
    if (ours === text) continue;
    const baseText = base.get(path);
    const merged = mergeState(
      baseText === undefined ? undefined : parse(path, baseText, 'last shared'),
      ours === undefined ? undefined : parse(path, ours, 'local'),
      parse(path, text, branch),
    );
    const keys = entryFor(path)!.keys;
    const full = local.full.get(path);
    // This machine removed a record that the branch did not change.
    if (merged === undefined) continue;
    let next = merged;
    if (keys) {
      // Only part of the file is shared: the rest belongs to the local file, so there must be one.
      if (full === undefined) continue;
      next = place(parse(path, full, 'local') as Json, merged as Json);
    }
    const out = json(next);
    if (out !== full) writes.push([path, out]);
  }
  const dir = paths.dir(root);
  for (const [path, text] of writes) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.tmp-state-${process.pid}`;
    await writeFile(temp, text);
    await rename(temp, file);
  }
  return writes.length;
}

/**
 * Merges the state on the remote `branch` into the local state files
 * (STATE_FILES), before a cycle. Returns the number of files it changed.
 * A missing branch changes nothing.
 */
export async function pullState(root: string, branch: string): Promise<{ changed: number }> {
  const tip = await fetchTip(root, branch);
  if (!tip) return { changed: 0 };
  const changed = await mergeLocal(root, branch, tip);
  await saveBase(root, branch, tip);
  return { changed };
}

/** Writes `files` as a git tree through a temporary index, so the checkout and its index stay as they are. */
async function writeTree(root: string, files: Files): Promise<string> {
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  const temp = await mkdtemp(join(tmpdir(), 'bugpatrol-state-'));
  try {
    const work = join(temp, 'tree');
    for (const [path, text] of files) {
      await mkdir(dirname(join(work, path)), { recursive: true });
      await writeFile(join(work, path), text);
    }
    await mkdir(work, { recursive: true });
    const env = { GIT_DIR: gitDir, GIT_INDEX_FILE: join(temp, 'index'), GIT_WORK_TREE: work };
    await git(work, ['-c', 'core.autocrlf=false', 'add', '-A', '-f', '.'], env);
    return (await git(work, ['write-tree'], env)).trim();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Bugpatrol',
  GIT_AUTHOR_EMAIL: 'bugpatrol@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Bugpatrol',
  GIT_COMMITTER_EMAIL: 'bugpatrol@users.noreply.github.com',
};

/**
 * Pushes the local state files (STATE_FILES) to the remote `branch`, after a
 * cycle. It first merges what another writer pushed, then pushes without
 * force. When another push wins the race, it merges and tries again, at most
 * PUSH_ATTEMPTS times; then it fails and overwrites nothing.
 */
export async function pushState(root: string, branch: string): Promise<{ commit?: string }> {
  let lost = '';
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    const tip = await fetchTip(root, branch);
    if (tip) await mergeLocal(root, branch, tip);
    const tree = await writeTree(root, (await readLocal(root)).shared);
    if (tip && (await git(root, ['rev-parse', `${tip}^{tree}`])).trim() === tree) {
      await saveBase(root, branch, tip);
      return {};
    }
    const commit = (
      await git(
        root,
        ['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', 'Bugpatrol state', '--no-gpg-sign'],
        IDENTITY,
      )
    ).trim();
    try {
      await git(root, ['push', '-q', REMOTE, `${commit}:refs/heads/${branch}`]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (!/rejected|non-fast-forward|fetch first|failed to update ref|cannot lock ref/i.test(stderr)) throw error;
      lost = stderr.trim();
      continue;
    }
    await saveBase(root, branch, commit);
    return { commit };
  }
  throw new Error(
    `Could not push the state to ${branch}: another writer pushed first ${PUSH_ATTEMPTS} times. Nothing was overwritten. ${lost}`,
  );
}
