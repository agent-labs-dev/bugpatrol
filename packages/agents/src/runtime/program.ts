import { accessSync, constants } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

/** The first word of a shell command that names a program, past any `NAME=value`. */
export function commandProgram(command: string): string | undefined {
  return command
    .trim()
    .split(/\s+/)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
}

export function isOpencode(program: string): boolean {
  return basename(program) === 'opencode';
}

export function onPath(program: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const candidates = program.includes('/')
    ? [program]
    : (env.PATH ?? '').split(delimiter).map((dir) => join(dir, program));
  return candidates.some((file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
