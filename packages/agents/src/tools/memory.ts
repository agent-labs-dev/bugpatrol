import { LESSON_MAX_LENGTH, type Lesson, type LessonRole, lessonTooLong } from '@bugpatrol/core';
import type { AgentSession } from '../session.js';
import type { Tool } from '../types.js';

const roles: LessonRole[] = ['explorer', 'judge', 'fixer'];

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'not',
  'are',
  'was',
  'has',
  'have',
  'its',
  'use',
  'when',
  'then',
  'than',
  'there',
  'can',
  'does',
  'will',
  'must',
  'only',
  'also',
  'you',
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9_.:/-]+/g)
      ?.map((word) => word.replace(/[.:]+$/, '').replace(/s$/, ''))
      .filter((word) => word.length > 2 && !STOP.has(word)) ?? [],
  );
}

/**
 * A lesson with the same meaning, in other words. Two agents that see the
 * same cause write it differently, and the exact-text check in upsertLessons
 * does not see that. The overlap is of the shorter lesson, so a longer
 * version of a lesson still matches it.
 */
export function similarLesson(lessons: Lesson[], role: LessonRole, text: string): Lesson | undefined {
  const mine = words(text);
  let best: { lesson: Lesson; score: number } | undefined;
  for (const lesson of lessons) {
    if (lesson.role !== role || lesson.retired) continue;
    const theirs = words(lesson.text);
    const shared = [...mine].filter((word) => theirs.has(word)).length;
    const score = shared / Math.max(1, Math.min(mine.size, theirs.size));
    if (shared >= 4 && score >= 0.6 && (!best || score > best.score)) best = { lesson, score };
  }
  return best?.lesson;
}

/**
 * Lets a role save what it learned about this app or its code while it works,
 * so that a later session does not have to find it again. A role can also save
 * a lesson for another role: the judge sees why a fix did not work, and the
 * fixer needs that lesson next time. Returns no tool when memory is off.
 */
export function lessonTools(session: AgentSession, role: LessonRole): Tool[] {
  const memory = session.config.agents.memory;
  if (!memory.enabled) return [];
  let saved = 0;
  return [
    {
      name: 'save_lesson',
      description:
        'Save one lasting fact about this app or its code for later sessions: one short, specific ' +
        `sentence of at most ${LESSON_MAX_LENGTH} characters. Use "for" to save it for another role ` +
        '(explorer, judge, or fixer). When a similar lesson ' +
        'exists, the tool shows it and saves nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          for: { type: 'string', enum: roles },
          scope: { type: 'string', description: 'A screen id, or leave it out for the whole app.' },
          same: {
            type: 'string',
            description:
              'The id of a saved lesson that has the same meaning. It confirms ' + 'that lesson, and saves no new one.',
          },
          different: { type: 'boolean', description: 'true saves the lesson also when a similar lesson exists.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async run(input) {
        if (saved >= memory.maxPerSession) {
          return { content: [{ type: 'text', text: 'The lesson limit for this session is reached.' }] };
        }
        const text = (session.vars.redact(String(input.text ?? '')) as string).trim();
        if (!text) return { content: [{ type: 'text', text: 'The lesson needs a text.' }], isError: true };
        const target = roles.includes(input.for as LessonRole) ? (input.for as LessonRole) : role;
        const { lessons } = await session.workspace.readMemory();
        const confirmed = input.same
          ? lessons.find((lesson) => lesson.id === input.same && !lesson.retired)
          : undefined;
        if (confirmed) {
          // The exact text again, so upsertLessons counts one more hit on it.
          await session.workspace.upsertLessons([
            { role: confirmed.role, text: confirmed.text, source: confirmed.source, scope: confirmed.scope },
          ]);
          return { content: [{ type: 'text', text: `Confirmed ${confirmed.id}. It has one more hit now.` }] };
        }
        const tooLong = lessonTooLong(text);
        if (tooLong) return { content: [{ type: 'text', text: tooLong }], isError: true };
        const similar = input.different === true ? undefined : similarLesson(lessons, target, text);
        if (similar && similar.text.toLowerCase() !== text.toLowerCase()) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `The ${target} already has a similar lesson: ${similar.id}: "${similar.text}" ` +
                  `If it has the same meaning, call save_lesson with same: "${similar.id}". If your lesson tells something ` +
                  'new, call it again with different: true.',
              },
            ],
          };
        }
        const [lesson] = await session.workspace.upsertLessons([
          { role: target, text, source: 'agent', scope: input.scope ? String(input.scope) : undefined },
        ]);
        saved++;
        session.emit({ kind: 'lesson', summary: `Learned (${target}): ${lesson!.text}` });
        return { content: [{ type: 'text', text: `Saved ${lesson!.id} for the ${target}.` }] };
      },
    },
  ];
}
