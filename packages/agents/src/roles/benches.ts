import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BenchBuild, Claim, ClaimBench, PrReview } from '@bugpatrol/core';
import { judgeBenchesSystem } from '../prompts.js';
import { createRuntime as makeRuntime } from '../runtime/index.js';
import { AgentSession } from '../session.js';
import type { Tool } from '../types.js';
import { Vars } from '../vars.js';
import { lessonsFor } from '../workspace.js';
import type { ReviewContext } from './review.js';

const exec = promisify(execFile);
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const response = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/** What a picked benchmark gave a claim: the numbers of both builds, or why it measured nothing. */
export type Measured = { kind: 'bench'; bench: ClaimBench } | { kind: 'failed'; reason: string };

/** The two spreads overlap, so the difference may be noise. */
export const overlaps = ({ head, base }: ClaimBench) => head.min <= base.max && base.min <= head.max;

/**
 * The judge picks which declared benchmarks measure which claims. It can
 * name a declared benchmark only, so it never invents a measurement.
 */
export async function pickBenches(ctx: ReviewContext, review: PrReview, claims: Claim[]): Promise<Map<string, string>> {
  const { root, config, workspace, pr, opts } = ctx;
  const benches = config.agents.review.benches;
  const names = benches.map((bench) => bench.name);
  const vars = new Vars(config.app.secrets);
  const record = await workspace.startSession('judge');
  review.sessions.benches = record.id;
  const session = new AgentSession(root, config, vars, record.id, 'judge', undefined, ctx.log);
  opts.onSession?.(session);
  const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.judge.use);
  const picks = new Map<string, string>();
  const tools: Tool[] = [
    {
      name: 'pick_bench',
      description: 'Measure one claim about speed with one declared benchmark.',
      inputSchema: schema({ claim: string, bench: { type: 'string', enum: names } }, ['claim', 'bench']),
      async run(input) {
        if (!claims.some((claim) => claim.id === input.claim))
          return { ...response(`Unknown claim. The claims: ${claims.map((c) => c.id).join(', ')}.`), isError: true };
        if (!names.includes(String(input.bench)))
          return { ...response(`Unknown benchmark. Pick one of ${names.join(', ')}.`), isError: true };
        picks.set(String(input.claim), String(input.bench));
        return response(`${input.claim}: ${input.bench}.`);
      },
    },
    {
      name: 'finish',
      description: 'Finish with one sentence, when each speed claim that a benchmark measures has one.',
      inputSchema: schema({ summary: string }, ['summary']),
      async run(input) {
        return { ...response(String(input.summary ?? '')), done: true };
      },
    },
  ];
  const limits = config.agents.review;
  let cost = 0;
  let steps = 0;
  let status: 'finished' | 'failed' = 'finished';
  const start = `Picking the benchmarks for PR #${pr.number}`;
  await session.activity(start, 0, runtime.label);
  session.emit({ kind: 'session-start', summary: start });
  try {
    const outcome = await runtime.run(
      {
        role: 'judge',
        sessionId: record.id,
        system: judgeBenchesSystem(lessonsFor(await workspace.readMemory(), 'judge')),
        prompt: [
          `PULL REQUEST #${pr.number}: ${pr.title}`,
          `DIFF (each line has its sign, then its line number in the new file)\n${pr.diff}`,
          `BENCHMARKS\n${benches.map((bench) => `- ${bench.name}: ${bench.metric}, ${bench.better} is better. Runs: ${bench.command}`).join('\n')}`,
          `CLAIMS\n${claims.map((claim) => `- ${claim.id}: ${claim.text}`).join('\n')}`,
        ].join('\n\n'),
        tools,
        maxSteps: Math.max(limits.maxSteps, claims.length + 4),
        budgetUsd: limits.budgetUsd,
        timeoutMs: limits.timeoutMs,
      },
      session.emit,
    );
    cost = outcome.costUsd;
    steps = outcome.steps;
  } catch (error) {
    status = 'failed';
    throw error;
  } finally {
    review.costUsd += cost;
    const summary = `PR #${pr.number}: ${picks.size} claim(s) to measure`;
    await workspace.endSession(record.id, { status, summary, steps, costUsd: cost });
    session.emit({ kind: 'session-end', summary });
    await session.idle(cost);
    opts.onSession?.();
  }
  return picks;
}

function stats(values: number[]): BenchBuild {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { values, median, min: sorted[0]!, max: sorted.at(-1)! };
}

/**
 * Runs each picked benchmark on the two builds in turn (base, pull request,
 * base, pull request), so a runner that slows down hits both builds alike.
 * A command that fails, or prints no number, measures nothing; that is the
 * reason of its claims, never an error of the review.
 */
export async function runBenches(
  ctx: ReviewContext,
  picks: Map<string, string>,
  worktrees: <T>(run: (dirs: { head: string; base: string }) => Promise<T>) => Promise<T>,
): Promise<Map<string, Measured>> {
  const vars = new Vars(ctx.config.app.secrets);
  const picked = ctx.config.agents.review.benches.filter((bench) => [...picks.values()].includes(bench.name));
  const results = new Map<string, Measured>();
  if (picked.length)
    await worktrees(async (dirs) => {
      for (const bench of picked) {
        const pattern = new RegExp(bench.parse);
        const values = { head: [] as number[], base: [] as number[] };
        try {
          for (let run = 0; run < bench.runs; run++)
            for (const build of ['base', 'head'] as const) {
              const where = build === 'head' ? 'the pull request build' : 'the base build';
              ctx.log(`Benchmark ${bench.name}: run ${run + 1} of ${bench.runs} on ${where}`);
              let output: string;
              try {
                const { stdout, stderr } = await exec('/bin/sh', ['-c', bench.command], {
                  cwd: dirs[build],
                  timeout: bench.timeoutMs,
                  maxBuffer: 16 * 1024 * 1024,
                });
                output = `${stdout}\n${stderr}`;
              } catch (error) {
                throw new Error(`failed on ${where}: ${String(error).split('\n')[0]}`);
              }
              const value = Number(pattern.exec(output)?.[1]);
              if (!Number.isFinite(value)) throw new Error(`printed no number that matches ${bench.parse} on ${where}`);
              values[build].push(value);
            }
          const { name, command, metric, better, runs } = bench;
          results.set(name, {
            kind: 'bench',
            bench: { name, command, metric, better, runs, head: stats(values.head), base: stats(values.base) },
          });
        } catch (error) {
          const reason = vars.redact(`The benchmark ${bench.name} ${(error as Error).message}.`) as string;
          ctx.log(reason);
          results.set(bench.name, { kind: 'failed', reason });
        }
      }
    });
  return new Map([...picks].map(([claim, name]) => [claim, results.get(name)!]));
}

/** The numbers of a benchmark, in words for the judge. */
export function benchWords(bench: ClaimBench): string {
  const build = (numbers: BenchBuild) =>
    `median ${numbers.median}, spread ${numbers.min} to ${numbers.max} (${numbers.values.join(', ')})`;
  return [
    `Bugpatrol ran the benchmark ${bench.name} ${bench.runs} time(s) on each build, in turn. It measures ${bench.metric}; ${bench.better} is better.`,
    `Base build: ${build(bench.base)}.`,
    `Pull request build: ${build(bench.head)}.`,
    overlaps(bench) ? 'The spreads overlap, so the difference may be noise.' : 'The spreads do not overlap.',
  ].join('\n');
}
