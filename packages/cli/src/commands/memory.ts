import { Workspace } from '@bugpatrol/agents';
import { ConfigError, type LessonRole, lessonTooLong } from '@bugpatrol/core';

const roles = new Set<LessonRole>(['explorer', 'judge', 'fixer']);
const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

export async function runMemoryCommand(args: string[], root: string, log: (line: string) => void): Promise<void> {
  const [action = 'list', id, ...rest] = args;
  const workspace = new Workspace(root);
  if (action === 'list') {
    const role = flag(args.slice(1), '--role');
    if (role && !roles.has(role as LessonRole)) throw new ConfigError(`Unknown memory role: ${role}`);
    const lessons = (await workspace.readMemory()).lessons.filter((lesson) => !role || lesson.role === role);
    log('id  role  hits  source  scope  text');
    for (const lesson of lessons)
      log(
        `${lesson.id}  ${lesson.role}  ${lesson.hits}  ${lesson.source}  ${lesson.scope ?? 'app'}  ${lesson.text}${lesson.retired ? ' [retired]' : ''}`,
      );
    if (!lessons.length) log('No lessons.');
    return;
  }
  if (action === 'add') {
    const role = flag(args.slice(1), '--role');
    const text = args
      .slice(1)
      .find(
        (part, index, all) => !part.startsWith('--') && all[index - 1] !== '--role' && all[index - 1] !== '--scope',
      );
    if (!role || !roles.has(role as LessonRole) || !text?.trim())
      throw new ConfigError('Usage: bugpatrol memory add --role explorer|judge|fixer "text" [--scope s]');
    const tooLong = lessonTooLong(text);
    if (tooLong) throw new ConfigError(tooLong);
    const [lesson] = await workspace.upsertLessons([
      { role: role as LessonRole, source: 'human', scope: flag(args.slice(1), '--scope'), text },
    ]);
    log(`Added ${lesson!.id}`);
    return;
  }
  if (!id) throw new ConfigError(`bugpatrol memory ${action} needs a lesson id`);
  if (action === 'remove') {
    await workspace.removeLesson(id);
    log(`Removed ${id}`);
    return;
  }
  if (action === 'retire') {
    const reason = flag(rest, '--reason');
    if (!reason) throw new ConfigError('bugpatrol memory retire needs --reason');
    await workspace.retireLesson(id, reason);
    log(`Retired ${id}`);
    return;
  }
  throw new ConfigError(`Unknown memory action: ${action}`);
}
