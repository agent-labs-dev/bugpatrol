import { readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import {
  type AgentEvent,
  type BugpatrolConfig,
  instructionsPath,
  LESSON_MAX_LENGTH,
  type Lesson,
  lessonTooLong,
} from '@bugpatrol/core';
import { createRuntime as makeRuntime } from '../runtime/index.js';
import type { Tool } from '../types.js';
import { Vars } from '../vars.js';
import { lessonsFor, Workspace } from '../workspace.js';

const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/** Summarise mechanical trouble before asking a model to write any lesson. */
export function troubleLog(events: AgentEvent[], summary = ''): string[] {
  const lines: string[] = [];
  let previous = '';
  let repeats = 0;
  let lastType = '';
  let typeRepeats = 0;
  let waits = 0;
  let call: AgentEvent | undefined;
  for (const event of events) {
    if (event.kind !== 'tool-call' && event.kind !== 'tool-result') continue;
    if (event.kind === 'tool-call') {
      call = event;
      const key = `${event.tool}:${JSON.stringify(event.input ?? {})}`;
      repeats = key === previous ? repeats + 1 : 1;
      if (repeats === 2) lines.push(`Repeated ${event.tool} with the same input: ${JSON.stringify(event.input ?? {})}`);
      previous = key;
      const target = event.tool === 'type' ? String((event.input as { ref?: string })?.ref ?? 'focused field') : '';
      typeRepeats = target && target === lastType ? typeRepeats + 1 : 1;
      if (typeRepeats >= 2)
        lines.push(`Typed into ${target} again: ${JSON.stringify((event.input as { text?: string })?.text ?? '')}`);
      lastType = target;
      waits = event.tool === 'wait' ? waits + 1 : 0;
      if (waits === 3) lines.push('Waited three or more times in a row.');
    } else {
      // Playwright call logs carry terminal colour codes and many lines; the
      // first line says what failed.
      const output = stripVTControlCharacters(String(event.output ?? '')).split('\n')[0]!;
      if (event.summary.endsWith(': failed') || /Error:|failed at step|failed at \d+|timed out/i.test(output)) {
        lines.push(
          `Failed ${event.tool ?? call?.tool}: ${JSON.stringify(call?.input ?? {})} — ${output || event.summary}`,
        );
      }
      if (event.tool === 'run_routine' && /failed/i.test(output)) lines.push(`Routine replay failed: ${output}`);
    }
  }
  if (
    /used all its steps|reached its budget|reached its time limit|stopped on an error|stopped: (max-steps|budget|timeout|error)/i.test(
      summary,
    )
  )
    lines.push(`Stop reason: ${summary}`);
  if (lines.length && summary) lines.push(`Final summary: ${summary}`);
  return lines.slice(0, 150).map((line) => line.slice(0, 500));
}

export async function reflectOnSession(
  root: string,
  config: BugpatrolConfig,
  sessionId: string,
  deps: { createRuntime?: typeof makeRuntime; onLog?: (message: string) => void; vars?: Vars } = {},
): Promise<number> {
  if (!config.agents.memory.enabled) return 0;
  const workspace = new Workspace(root);
  const session = (await workspace.listSessions(Infinity)).find((item) => item.id === sessionId);
  const lines = troubleLog(await workspace.readEvents(sessionId), session?.summary);
  if (!lines.length) return 0;
  const memory = await workspace.readMemory();
  const existing = lessonsFor(memory, 'explorer');
  const ids = new Set(existing.map((item) => item.id));
  const vars = deps.vars ?? new Vars(config.app.secrets);
  const file = instructionsPath(root, config.app.instructions);
  const guide = file ? await readFile(file, 'utf8') : '';
  const record = await workspace.startSession('explorer');
  const emit = workspace.recordEvent(record.id, 'explorer', vars);
  let added = 0;
  let outcome: { steps: number; costUsd: number; stop: string } | undefined;
  try {
    const tools: Tool[] = [
      {
        name: 'add_lesson',
        description: `Save one specific imperative lesson of at most ${LESSON_MAX_LENGTH} characters.`,
        inputSchema: schema({ text: string, scope: string }, ['text']),
        async run(input) {
          if (added >= config.agents.memory.maxPerSession) return reply('Lesson limit reached.');
          const text = (vars.redact(String(input.text ?? '')) as string).trim();
          if (!text) return reply('Lesson text is required.');
          const tooLong = lessonTooLong(text);
          if (tooLong) return { ...reply(tooLong), isError: true };
          const [lesson] = await workspace.upsertLessons([
            { role: 'explorer', text, scope: input.scope ? String(input.scope) : undefined, source: 'reflection' },
          ]);
          added++;
          emit({ kind: 'lesson', summary: `Learned: ${lesson!.text}` });
          return reply(`Saved ${lesson!.id}`);
        },
      },
      {
        name: 'keep_lesson',
        description: 'Mark an existing lesson as useful again.',
        inputSchema: schema({ id: string }, ['id']),
        async run(input) {
          const lesson = existing.find((item) => item.id === input.id);
          if (!lesson || !ids.has(lesson.id)) return { ...reply('Unknown lesson.'), isError: true };
          await workspace.upsertLessons([
            { role: lesson.role, scope: lesson.scope, text: lesson.text, source: lesson.source },
          ]);
          return reply(`Kept ${lesson.id}`);
        },
      },
      {
        name: 'retire_lesson',
        description: 'Retire a wrong or failed existing lesson.',
        inputSchema: schema({ id: string, reason: string }, ['id', 'reason']),
        async run(input) {
          if (!ids.has(String(input.id))) return { ...reply('Unknown lesson.'), isError: true };
          await workspace.retireLesson(String(input.id), vars.redact(String(input.reason)) as string);
          return reply(`Retired ${input.id}`);
        },
      },
      {
        name: 'finish',
        description: 'Finish reflecting.',
        inputSchema: schema(),
        async run() {
          return { ...reply('Finished.'), done: true };
        },
      },
    ];
    outcome = await (deps.createRuntime ?? makeRuntime)(config.agents.explorer.use).run(
      {
        role: 'explorer',
        sessionId: record.id,
        system: `You review a QA explorer's run of this app. Write lessons that would have saved steps or avoided a mistake. Each lesson is ONE imperative sentence of at most ${LESSON_MAX_LENGTH} characters that a future explorer can follow: what to do and where. Be specific to this app: name the screen, field, or control. Never include a secret value; placeholders such as {{E2E_RUN_ID}} are fine. Do not restate the app guide. Add at most ${config.agents.memory.maxPerSession} lessons. If an existing lesson already says it, call keep_lesson with its id. If one was followed and still failed, or is wrong, call retire_lesson with a reason. Then call finish.`,
        prompt: `TROUBLE LOG\n${lines.join('\n')}\n\nEXISTING LESSONS\n${existing.map((item: Lesson) => `${item.id}: ${item.text}`).join('\n') || '(none)'}\n\nAPP GUIDE\n${guide || '(none)'}`,
        tools,
        maxSteps: config.agents.memory.reflectMaxSteps,
        budgetUsd: config.agents.memory.reflectBudgetUsd,
        timeoutMs: config.agents.explorer.timeoutMs,
      },
      emit,
    );
  } catch (error) {
    deps.onLog?.(`Reflection failed: ${String(error)}`);
  } finally {
    await workspace.endSession(record.id, {
      summary: `Learned ${added} lesson(s)`,
      status: outcome?.stop === 'error' ? 'failed' : 'finished',
      steps: outcome?.steps ?? 0,
      costUsd: outcome?.costUsd ?? 0,
    });
  }
  return added;
}
