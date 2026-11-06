import { resolve, sep } from 'node:path';
import type { Routine, RoutineStep } from '@bugpatrol/core';

/** System paths that every machine that runs the app has. */
const SYSTEM = ['/dev/', '/usr/', '/bin/', '/sbin/', '/proc/', '/sys/', '/etc/', '/opt/homebrew/'];

/** An absolute or home path that starts a word: after a space, a quote, `=`, `>` or `<`. */
const PATH = /(?:^|[\s'"=<>(])((?:~|\/)[^\s'"<>|;&)]*)/g;

function texts(step: RoutineStep): string[] {
  switch (step.kind) {
    case 'run':
      return [step.command, step.input ?? ''];
    case 'session':
      return step.op === 'start' ? [step.command] : [];
    case 'type':
      return [step.value];
    default:
      return [];
  }
}

/**
 * The paths that a routine's commands use outside the project root, such as
 * a helper the explorer made in /tmp. A committed routine replays from a clean
 * clone, where those files do not exist.
 */
export function outsidePaths(routine: Routine, root: string): string[] {
  const inside = resolve(root) + sep;
  const found = routine.steps
    .flatMap(texts)
    .flatMap((text) => [...text.matchAll(PATH)].map((match) => match[1]!))
    .filter((path) => path.length > 1 && path !== '~')
    .filter(
      (path) => path.startsWith('~') || !(`${path}/`.startsWith(inside) || SYSTEM.some((dir) => path.startsWith(dir))),
    );
  return [...new Set(found)];
}

/** A warning for the routine's outside paths, or undefined when it has none. */
export function portabilityWarning(routine: Routine, root: string): string | undefined {
  const found = outsidePaths(routine, root);
  if (!found.length) return undefined;
  return `The routine ${routine.id} uses ${found.join(', ')}, outside the project. A clean clone or CI cannot replay it: put the file in the project, or do the step without it.`;
}
