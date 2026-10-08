import type { AgentEvent } from '@bugpatrol/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoleTask, Tool } from '../types.js';
import { ModelRuntime } from './model.js';

const oldKey = process.env.OPENAI_API_KEY;
const oldAnthropic = process.env.ANTHROPIC_API_KEY;
const oldOpenrouter = process.env.OPENROUTER_API_KEY;
beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test';
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.OPENROUTER_API_KEY = 'test';
});
afterEach(() => {
  if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldKey;
  if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = oldAnthropic;
  if (oldOpenrouter === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = oldOpenrouter;
});

function task(tools: Tool[], maxSteps = 8, budgetUsd = 1): RoleTask {
  return {
    role: 'explorer',
    sessionId: 's',
    system: 'system',
    prompt: 'prompt',
    tools,
    maxSteps,
    budgetUsd,
    timeoutMs: 20_000,
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const finish: Tool = {
  name: 'finish',
  description: 'Finish',
  inputSchema: { type: 'object' },
  async run() {
    return { content: [{ type: 'text', text: 'finished' }], done: true };
  },
};

function call(name: string, id = 'c1') {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

describe('ModelRuntime', () => {
  it('returns malformed arguments to the model and charges a multi-tool step once', async () => {
    let requests = 0;
    const fake = async () => {
      requests++;
      return requests === 1
        ? response({
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: 'bad', function: { name: 'finish', arguments: '{broken' } },
                    { id: 'ok', function: { name: 'look', arguments: '{}' } },
                  ],
                },
              },
            ],
            usage: { cost: 0.2 },
          })
        : response({ choices: [{ message: { tool_calls: [call('finish')] } }] });
    };
    const look: Tool = {
      name: 'look',
      description: 'Look',
      inputSchema: { type: 'object' },
      async run() {
        return { content: [{ type: 'text', text: 'looked' }] };
      },
    };
    const events: Partial<AgentEvent>[] = [];
    const runtime = new ModelRuntime(
      { runtime: 'model', via: 'openai', model: 'test' },
      { fetch: fake as typeof fetch },
    );
    const outcome = await runtime.run(task([finish, look]), (event) => events.push(event));
    expect(outcome.stop).toBe('done');
    expect(events.some((event) => String(event.output).includes('arguments were not valid JSON'))).toBe(true);
    expect(
      events.filter((event) => event.kind === 'tool-result').reduce((sum, event) => sum + (event.costUsd ?? 0), 0),
    ).toBe(0.2);
    expect(events.some((event) => event.summary?.startsWith('Tokens:'))).toBe(false);
  });

  it('runs tools and places screenshots after tool messages, then prunes old images', async () => {
    const bodies: Record<string, unknown>[] = [];
    let requests = 0;
    const snap: Tool = {
      name: 'snap',
      description: 'Screenshot',
      inputSchema: { type: 'object' },
      async run() {
        return {
          content: [
            { type: 'text', text: 'screen' },
            { type: 'image', png: Buffer.from('png') },
          ],
        };
      },
    };
    const fake = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requests++;
      const name = requests === 4 ? 'finish' : 'snap';
      return response({
        choices: [{ message: { content: '', tool_calls: [call(name, `c${requests}`)] } }],
        usage: { cost: 0.1, prompt_tokens: 5, completion_tokens: 2 },
      });
    };
    const events: Partial<AgentEvent>[] = [];
    const runtime = new ModelRuntime(
      { runtime: 'model', via: 'openrouter', model: 'test' },
      { fetch: fake as typeof fetch },
    );
    const outcome = await runtime.run(task([snap, finish]), (event) => events.push(event));
    expect(outcome).toMatchObject({ stop: 'done', steps: 4, costUsd: 0.4, summary: 'finished' });
    const thirdMessages = bodies[2]?.messages as { role: string; content?: unknown }[];
    expect(thirdMessages.slice(-2).map((message) => message.role)).toEqual(['tool', 'user']);
    const fourthMessages = bodies[3]?.messages as { role: string; content?: unknown }[];
    expect(JSON.stringify(fourthMessages)).toContain('[earlier screenshot omitted]');
    expect(JSON.stringify(fourthMessages)).toContain('data:image/png;base64');
    expect(bodies[0]?.usage).toEqual({ include: true });
    expect(events.some((event) => event.kind === 'tool-result' && event.costUsd === 0.1)).toBe(true);
  });

  it('stops at cost budget and max steps', async () => {
    const fake = async () =>
      response({
        choices: [{ message: { content: 'thinking', tool_calls: [] } }],
        usage: { cost: 0.2 },
      });
    const runtime = new ModelRuntime(
      { runtime: 'model', via: 'openai', model: 'test' },
      { fetch: fake as typeof fetch },
    );
    expect((await runtime.run(task([finish], 5, 0.1), () => {})).stop).toBe('budget');
    expect((await runtime.run(task([finish], 1, 1), () => {})).stop).toBe('max-steps');
  });

  it('offers only finish once the steps are used, and keeps its summary', async () => {
    const bodies: { tools: { name: string }[]; messages: { role: string; content: unknown }[] }[] = [];
    const fake = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
      bodies.push(body);
      const name = body.tools.length === 1 ? 'finish' : 'look';
      return response({
        content: [{ type: 'tool_use', id: `c${bodies.length}`, name, input: {} }],
      });
    };
    const look: Tool = {
      name: 'look',
      description: 'Look',
      inputSchema: { type: 'object' },
      async run() {
        return { content: [{ type: 'text', text: 'a screen' }] };
      },
    };
    const runtime = new ModelRuntime(
      { runtime: 'model', via: 'anthropic', model: 'test' },
      { fetch: fake as typeof fetch },
    );
    expect(await runtime.run(task([look, finish], 2), () => {})).toMatchObject({
      stop: 'max-steps',
      steps: 3,
      summary: 'finished',
      finished: true,
    });
    expect(bodies[2]?.tools.map((tool) => tool.name)).toEqual(['finish']);
    // The note shares the user turn of the tool results: Anthropic wants one user turn there.
    expect(bodies[2]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result' }, { type: 'text', text: expect.stringContaining('Call finish now') }],
    });
  });

  it('nudges text-only answers and finishes after three', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fake = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ choices: [{ message: { content: 'plain answer' } }] });
    };
    const runtime = new ModelRuntime(
      { runtime: 'model', via: 'openai', model: 'test' },
      { fetch: fake as typeof fetch },
    );
    expect(await runtime.run(task([finish]), () => {})).toMatchObject({
      stop: 'done',
      steps: 3,
      summary: 'plain answer',
    });
    expect(JSON.stringify(bodies[1])).toContain('Call one of the tools');
  });

  it('retries a 429 and sends Anthropic tool blocks', async () => {
    let attempts = 0;
    const retry = async () => {
      attempts++;
      return attempts === 1
        ? response({ error: 'rate limited' }, 429)
        : response({ choices: [{ message: { tool_calls: [call('finish')] } }] });
    };
    const openai = new ModelRuntime(
      { runtime: 'model', via: 'openai', model: 'test' },
      { fetch: retry as typeof fetch },
    );
    expect((await openai.run(task([finish]), () => {})).stop).toBe('done');
    expect(attempts).toBe(2);
    let body: Record<string, unknown> = {};
    const anthropic = new ModelRuntime(
      { runtime: 'model', via: 'anthropic', model: 'test' },
      {
        fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return response({ content: [{ type: 'tool_use', id: 'a', name: 'finish', input: {} }] });
        }) as typeof fetch,
      },
    );
    expect((await anthropic.run(task([finish]), () => {})).stop).toBe('done');
    expect(body).toMatchObject({
      max_tokens: 4096,
      system: 'system',
      tools: [{ name: 'finish', input_schema: { type: 'object' } }],
    });
  });
});
