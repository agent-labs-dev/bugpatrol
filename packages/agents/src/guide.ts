import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { type BugpatrolConfig, instructionsPath } from '@bugpatrol/core';

/** The app guide that the explorer works from. `text` is absent when the app has none. */
export type AppGuide = { path: string; text?: string };

/** Reads the app guide. A configured guide that is missing fails here. */
export async function readGuide(root: string, config: BugpatrolConfig): Promise<AppGuide> {
  const { path, required } = instructionsPath(root, config.app.instructions);
  return required || existsSync(path) ? { path, text: await readFile(path, 'utf8') } : { path };
}

/** The run log line for an app without a guide. */
export const noGuide = (root: string, guide: AppGuide) =>
  `No app guide at ${relative(root, guide.path)}, so the explorer runs without one.`;
