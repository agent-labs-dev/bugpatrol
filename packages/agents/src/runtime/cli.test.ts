import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentEvent } from '@bugpatrol/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { serveTools } from '../mcp-server.js';
import type { RoleTask, Tool } from '../types.js';
import { CliRuntime, parseCliOutput } from './cli.js';

const echo: Tool = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  async run(input) {
    return { content: [{ type: 'text', text: String(input.value) }] };
  },
};
const finish: Tool = {
  name: 'finish',
  description: 'Finish',
  inputSchema: { type: 'object' },
  async run() {
    return { content: [{ type: 'text', text: 'all done' }], done: true };
  },
};
const require = createRequire(import.meta.url);
const canListen = await new Promise<boolean>((done) => {
  const server = createServer();
  server.once('error', () => done(false));
  server.listen(0, '127.0.0.1', () => server.close(() => done(true)));
});
function task(workdir: string): RoleTask {
  return {
    role: 'fixer',
    sessionId: 'session',
    system: 'system',
    prompt: 'prompt',
    tools: [echo, finish],
    maxSteps: 2,
    budgetUsd: 1,
    timeoutMs: 5000,
    workdir,
  };
}

describe('MCP and CLI runtime', () => {
  it.skipIf(!canListen)('serves unchanged schemas to sequential SDK client sessions with a call budget', async () => {
    const server = await serveTools([echo, finish], { maxCalls: 1 });
    try {
      for (let n = 0; n < 2; n++) {
        const client = new Client({ name: 'test', version: '1' });
        const transport = new StreamableHTTPClientTransport(new URL(server.url));
        await client.connect(transport);
        const listed = await client.listTools();
        expect(listed.tools[0]?.inputSchema).toEqual(echo.inputSchema);
        const result = await client.callTool({ name: 'echo', arguments: { value: 'hi' } });
        expect((result.content as { type: string; text: string }[])[0]).toMatchObject({
          type: 'text',
          text: n === 0 ? 'hi' : 'The step budget is used. Call finish now.',
        });
        await client.close();
      }
    } finally {
      await server.close();
    }
  });

  it.skipIf(!canListen)('runs a CLI that calls echo and finish over MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-cli-test-'));
    const script = join(root, 'client.mjs');
    const clientUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href;
    const transportUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href;
    const source = `import { readFile } from 'node:fs/promises';
import { Client } from ${JSON.stringify(clientUrl)};
import { StreamableHTTPClientTransport } from ${JSON.stringify(transportUrl)};
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const client = new Client({ name: 'fake-cli', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpServers.bugpatrol.url)));
await client.callTool({ name: 'echo', arguments: { value: 'hello' } });
await client.callTool({ name: 'finish', arguments: {} });
await client.close();
console.log('cli complete');
`;
    await writeFile(script, source);
    try {
      const events: Partial<AgentEvent>[] = [];
      const runtime = new CliRuntime({ runtime: 'cli', command: `node ${JSON.stringify(script)} {mcp}` });
      const outcome = await runtime.run(task(root), (event) => events.push(event));
      expect(outcome).toMatchObject({ stop: 'done', summary: 'all done' });
      const calls = events.filter((event) => event.kind === 'tool-call').map((event) => event.tool);
      expect(calls).toEqual(['echo', 'finish']);
      expect(events.some((event) => event.kind === 'thought')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!canListen)('times out a CLI process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-cli-timeout-'));
    try {
      const runtime = new CliRuntime({ runtime: 'cli', command: 'sleep 10' });
      expect((await runtime.run({ ...task(root), timeoutMs: 100 }, () => {})).stop).toBe('timeout');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('CLI token usage', () => {
  it('reads the result, the usage, the list price, and the model from claude --output-format json', () => {
    const out = JSON.stringify({
      type: 'result',
      result: 'Filed 2 issues.',
      total_cost_usd: 0.12,
      usage: { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 },
      modelUsage: {
        'claude-haiku-4-5': { inputTokens: 10, outputTokens: 1 },
        'claude-sonnet-5': { inputTokens: 1492, outputTokens: 39 },
      },
    });
    expect(parseCliOutput(out)).toEqual({
      text: 'Filed 2 issues.',
      model: 'claude-sonnet-5',
      tokens: { input: 1502, output: 40, cacheRead: 1000, cacheWrite: 500, listCostUsd: 0.12 },
    });
  });

  it('adds up each turn of codex exec --json, and keeps only the message text', () => {
    const out = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"Looking at Settings."}}',
      '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":20}}',
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Done."}}',
      '{"type":"turn.completed","usage":{"input_tokens":500,"cached_input_tokens":0,"output_tokens":5}}',
    ].join('\n');
    expect(parseCliOutput(out)).toEqual({
      text: 'Looking at Settings.\nDone.',
      tokens: { input: 1500, output: 25, cacheRead: 800 },
    });
  });

  it('keeps plain text, with no usage', () => {
    expect(parseCliOutput('All done\n')).toEqual({ text: 'All done', tokens: undefined });
  });

  it.skipIf(!canListen)('emits one usage event with the tokens and the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-cli-usage-'));
    try {
      const out = JSON.stringify({
        result: 'ok',
        usage: { input_tokens: 7, output_tokens: 3 },
        modelUsage: { m1: { inputTokens: 7, outputTokens: 3 } },
      });
      await writeFile(join(root, 'out.json'), out);
      const events: Omit<AgentEvent, 'at' | 'sessionId' | 'role'>[] = [];
      const outcome = await new CliRuntime({ runtime: 'cli', command: `cat ${join(root, 'out.json')}` }).run(
        task(root),
        (event) => {
          events.push(event);
        },
      );
      expect(outcome).toMatchObject({ stop: 'done', summary: 'ok' });
      expect(events.find((event) => event.kind === 'usage')).toMatchObject({
        model: 'm1',
        tokens: { input: 7, output: 3 },
      });
      expect(events.some((event) => event.kind === 'thought' && event.summary.startsWith('{'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('opencode --format json', () => {
  const textEvent = (text: string) =>
    JSON.stringify({ type: 'text', timestamp: 2, sessionID: 'ses_1', part: { type: 'text', text } });

  it('joins the text events, and skips the step and tool events', () => {
    const out = [
      '{"type":"step_start","timestamp":1,"sessionID":"ses_1","part":{"type":"step-start"}}',
      textEvent('Looking at the dashboard.'),
      '{"type":"tool_use","timestamp":3,"sessionID":"ses_1","part":{"type":"tool","tool":"execute"}}',
      '{"type":"step_finish","timestamp":4,"sessionID":"ses_1","part":{"type":"step-finish","reason":"tool-calls"}}',
      textEvent('Done.'),
    ].join('\n');
    expect(parseCliOutput(out)).toEqual({ text: 'Looking at the dashboard.\nDone.' });
  });

  it('strips the thinking blocks, also one that never closes', () => {
    const out = [
      textEvent('<thinking>Not needed.</thinking>\n\nok'),
      textEvent("Let's try that.\n\n<thinking>I will use the search tool."),
    ].join('\n');
    expect(parseCliOutput(out)).toEqual({ text: "ok\nLet's try that." });
  });

  it('passes non-JSON lines through', () => {
    const out = ['starting up', textEvent('hi')].join('\n');
    expect(parseCliOutput(out)).toEqual({ text: 'starting up\nhi' });
  });

  it('reports the error message when there is no text', () => {
    const out =
      '{"type":"error","timestamp":1791554237076,"sessionID":"ses_edf0bd7b0ffeVMG5lgWPZuOnAL","error":{"type":"provider.auth","message":"anthropic.claude-haiku-5-5 is not available for this account. You can explore other available models on Amazon Bedrock.","status":403}}';
    expect(parseCliOutput(out)).toEqual({
      text: 'anthropic.claude-haiku-5-5 is not available for this account. You can explore other available models on Amazon Bedrock.',
    });
  });
});
