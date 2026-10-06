import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RetestShot, RoutineStep } from '@bugpatrol/core';
import { type replayRoutine, replaySteps } from '../replay.js';
import type { AgentSession } from '../session.js';
import { explorerTools } from '../tools/explorer.js';
import type { RoleOutcome, Runtime, Tool } from '../types.js';
import { stopOnCancellation } from './explorer.js';
import { stepWords } from './fixer.js';

const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const response = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

export async function image(root: string, file?: string): Promise<{ type: 'image'; png: Buffer }[]> {
  if (!file) return [];
  try {
    return [{ type: 'image', png: await readFile(resolve(root, file)) }];
  } catch {
    return [];
  }
}

/** A flow to repeat: `shot.before` is the screen as it was reported, `steps` follow the routine. */
export type CaptureTarget = { shot: RetestShot; steps: RoutineStep[] };

export function targetLines(targets: CaptureTarget[]): string {
  return targets
    .map(
      (target, index) =>
        `${index + 1}. screen ${target.shot.screenId ?? '(unknown)'} — routine ${target.shot.routineId ?? '(none)'} — steps: ${target.steps.map(stepWords).join('; ') || '(none)'}`,
    )
    .join('\n');
}

/**
 * The explorer repeats each target's flow on the build that runs now, and
 * captures what it sees in `shot.after`. A retest uses it on a fix build, and
 * a pull request review on the base build. The caller owns the session and
 * the verdict: the explorer only captures.
 */
export async function captureTargets(
  session: AgentSession,
  runtime: Runtime,
  targets: CaptureTarget[],
  task: { system: string; prompt: string; replay: NonNullable<Parameters<typeof replayRoutine>[2]> },
): Promise<RoleOutcome> {
  const driver = session.driver!;
  const config = session.config.agents;
  const targetSchema = { target: { type: 'integer', minimum: 1, maximum: targets.length } };
  const selected = (input: Record<string, unknown>) =>
    Number.isInteger(input.target) ? targets[Number(input.target) - 1] : undefined;
  let finishTried = false;
  let finishSummary = '';
  const allowed = new Set([
    'look',
    'tap',
    'type',
    'press',
    'scroll',
    'back',
    'open',
    'wait',
    'run_routine',
    'switch_window',
    'save_lesson',
  ]);
  const tools: Tool[] = explorerTools(session, { replay: task.replay }).filter((tool) => allowed.has(tool.name));
  tools.push(
    {
      name: 'replay_issue_steps',
      description: 'Replay the target steps after the routine.',
      inputSchema: schema(targetSchema, ['target']),
      async run(input) {
        const target = selected(input);
        if (!target) return { ...response('Choose a valid target number.'), isError: true };
        const result = await replaySteps(session, target.steps);
        if (!result.ok)
          return { ...response(`Issue steps failed at ${result.failedStep}: ${result.error}`), isError: true };
        await driver.settle();
        const observation = await driver.observe();
        const screenshot = await session.capture(observation, `retest-steps-${input.target}`);
        return {
          content: [
            { type: 'image', png: observation.screenshot },
            {
              type: 'text',
              text: session.vars.redact(
                `Replayed issue steps. Elements: ${observation.elements.map((item) => `[${item.ref}] ${item.role} ${item.name}`).join('; ')}`,
              ) as string,
            },
          ],
          meta: { screenshot, summary: `Replayed steps for screen ${input.target}` },
        };
      },
    },
    {
      name: 'view_before',
      description: 'View the target screenshot as it was reported.',
      inputSchema: schema(targetSchema, ['target']),
      async run(input) {
        const target = selected(input);
        if (!target) return { ...response('Choose a valid target number.'), isError: true };
        const content: Awaited<ReturnType<Tool['run']>>['content'] = [
          { type: 'text', text: `Screen ${input.target}: ${target.shot.screenId ?? '(unknown)'}` },
        ];
        content.push(...(await image(session.root, target.shot.before)));
        return { content };
      },
    },
    {
      name: 'capture_after',
      description: 'Capture the screen after replaying the flow.',
      inputSchema: schema({ ...targetSchema, note: string, reached: { type: 'boolean' } }, [
        'target',
        'note',
        'reached',
      ]),
      async run(input) {
        const target = selected(input);
        if (!target) return { ...response('Choose a valid target number.'), isError: true };
        await driver.settle();
        const observation = await driver.observe();
        target.shot.after = await session.capture(observation, `retest-after-${input.target}`);
        target.shot.note = String(input.note ?? '');
        target.shot.reached = input.reached === true;
        return {
          ...response(`Captured after screenshot for screen ${input.target}: ${target.shot.after}`),
          meta: { screenshot: target.shot.after, summary: `Retest capture: ${target.shot.note}` },
        };
      },
    },
    {
      name: 'finish_retest',
      description: 'Finish after capturing every target.',
      inputSchema: schema({ summary: string }, ['summary']),
      async run(input) {
        const missing = targets.flatMap((target, index) => (target.shot.after ? [] : [index + 1]));
        if (missing.length && !finishTried) {
          finishTried = true;
          return {
            ...response(`Missing captures for target numbers: ${missing.join(', ')}. Capture them, then finish again.`),
            isError: true,
          };
        }
        finishSummary = String(input.summary ?? '');
        return { ...response(finishSummary), done: true };
      },
    },
  );
  try {
    const result = await runtime.run(
      {
        role: 'explorer',
        sessionId: session.sessionId,
        system: task.system,
        prompt: task.prompt,
        tools: tools.map((tool) => stopOnCancellation(session, tool)),
        maxSteps: Math.max(config.fixer.retest.maxSteps, 12 * targets.length),
        budgetUsd: config.fixer.retest.budgetUsd,
        timeoutMs: config.explorer.timeoutMs,
      },
      session.emit,
    );
    if (!finishSummary && !targets.some((target) => target.shot.after))
      targets[0]!.shot.note = `The explorer stopped without capture_after (${result.stop}).`;
    return result;
  } finally {
    if (!targets.some((target) => target.shot.after) && targets[0]) {
      targets[0].shot.note ??= 'The explorer stopped without capture_after.';
      targets[0].shot.reached = false;
      try {
        targets[0].shot.after = await session.capture(await driver.observe(), 'retest-after-1');
      } catch {
        /* no screen */
      }
    }
    for (const target of targets)
      if (!target.shot.after) {
        target.shot.reached = false;
        target.shot.note = 'The explorer did not reach this screen.';
      }
  }
}
