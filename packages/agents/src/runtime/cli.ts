import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addUsage, formatUsage, type RoleRuntime, type TokenUsage, usageFrom } from '@bugpatrol/core';
import { serveTools } from '../mcp-server.js';
import type { EventSink, RoleOutcome, RoleTask, Runtime } from '../types.js';
import { firstLine } from './model.js';

type CliUse = Extract<RoleRuntime, { runtime: 'cli' }>;

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

type Parsed = { text: string; tokens?: TokenUsage; model?: string; error?: string };

function startsLikeJson(line: string): boolean {
  return line.trimStart().startsWith('{');
}

/**
 * One line of CLI output, as text for the activity feed. A JSON event line
 * (`codex exec --json`) becomes its message text, or nothing.
 */
function displayLine(line: string): string {
  if (!startsLikeJson(line)) return line;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      item?: { type?: string; text?: string };
      part?: { type?: string; text?: string };
    };
    if (
      event.type === 'item.completed' &&
      typeof event.item?.text === 'string' &&
      ['agent_message', 'reasoning'].includes(event.item.type ?? '')
    )
      return event.item.text;
    if (event.type === 'text' && typeof event.part?.text === 'string')
      return event.part.text.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, '').trim();
    return '';
  } catch {
    return line;
  }
}

function isStructuredEventLine(line: string): boolean {
  if (!startsLikeJson(line)) return false;
  try {
    const event = JSON.parse(line) as { type?: string; part?: { type?: unknown }; error?: { message?: unknown } };
    return typeof event.part?.type === 'string' || (event.type === 'error' && typeof event.error?.message === 'string');
  } catch {
    return false;
  }
}

function parseStructuredEvents(lines: string[]): Parsed {
  const text: string[] = [];
  const errors: string[] = [];
  let tokens: TokenUsage | undefined;
  let costUsd = 0;
  for (const line of lines) {
    if (startsLikeJson(line)) {
      try {
        const event = JSON.parse(line) as {
          type?: string;
          part?: {
            type?: string;
            text?: string;
            tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
            cost?: number;
          };
          error?: { message?: string };
        };
        if (event.type === 'text' && typeof event.part?.text === 'string') {
          const cleaned = event.part.text.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, '').trim();
          if (cleaned) text.push(cleaned);
        } else if (event.type === 'step_finish' && event.part?.tokens) {
          const t = event.part.tokens;
          tokens = addUsage(tokens, {
            input: (t.input ?? 0) + (t.reasoning ?? 0),
            output: t.output ?? 0,
            cacheRead: t.cache?.read ?? 0,
            cacheWrite: t.cache?.write ?? 0,
          });
          costUsd += event.part.cost ?? 0;
        } else if (event.type === 'error' && typeof event.error?.message === 'string') {
          errors.push(event.error.message);
        }
        continue;
      } catch {
        /* fall through to displayLine */
      }
    }
    const shown = displayLine(line);
    if (shown) text.push(shown);
  }
  if (tokens && costUsd) tokens.listCostUsd = costUsd;
  const joined = text.join('\n');
  const cause = errors.join('\n');
  return { text: joined, tokens, ...(cause ? { error: cause } : {}) };
}

/**
 * What a CLI printed: the text, and the token usage when the CLI reports it.
 * `claude -p --output-format json` prints one JSON object with the result and
 * its usage. `codex exec --json` prints one event on each line, with the usage
 * on each `turn.completed`. `opencode run --format json` prints one event on
 * each line, with the text on each `text` event. Plain text has no usage.
 */
export function parseCliOutput(stdout: string): Parsed {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const claude = JSON.parse(trimmed) as {
        result?: unknown;
        usage?: unknown;
        total_cost_usd?: unknown;
        modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>;
      };
      if (typeof claude.result === 'string' || claude.usage) {
        const tokens = usageFrom(claude.usage);
        if (tokens && typeof claude.total_cost_usd === 'number') tokens.listCostUsd = claude.total_cost_usd;
        const model = Object.entries(claude.modelUsage ?? {}).sort(
          ([, a], [, b]) =>
            (b.inputTokens ?? 0) + (b.outputTokens ?? 0) - ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)),
        )[0]?.[0];
        return { text: typeof claude.result === 'string' ? claude.result : '', tokens, model };
      }
    } catch {
      /* not one JSON object: read it line by line */
    }
  }
  let tokens: TokenUsage | undefined;
  let events = 0;
  const text: string[] = [];
  const lines = trimmed.split('\n');
  if (lines.some(isStructuredEventLine)) return parseStructuredEvents(lines);
  for (const line of lines) {
    if (startsLikeJson(line)) {
      try {
        const event = JSON.parse(line) as { type?: string; usage?: unknown };
        events++;
        if (event.type === 'turn.completed') tokens = addUsage(tokens, usageFrom(event.usage));
      } catch {
        /* a text line that starts with a brace */
      }
    }
    const shown = displayLine(line);
    if (shown) text.push(shown);
  }
  return { text: events ? text.join('\n') : trimmed, tokens };
}

/** A CLI gets the same tools over local MCP and a prompt on stdin and disk. */
export class CliRuntime implements Runtime {
  readonly label: string;

  constructor(private readonly use: CliUse) {
    this.label = `cli:${use.command.split(/\s+/)[0] ?? 'shell'}`;
  }

  async run(task: RoleTask, emit: EventSink): Promise<RoleOutcome> {
    const temp = await mkdtemp(join(tmpdir(), 'bugpatrol-agent-'));
    let summary = '';
    let finished = false;
    let steps = 0;
    let stderr = '';
    let stdout = '';
    let lastThought = 0;
    let pending = '';
    let partial = '';
    const onText = (chunk: string) => {
      // Whole lines only, so that a JSON event line is never cut in two.
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      const text = lines
        .map(displayLine)
        .filter(Boolean)
        .map((line) => `${line}\n`)
        .join('');
      if (!text) return;
      pending += text;
      const now = Date.now();
      if (now - lastThought >= 500) {
        const lines = pending.trim().split('\n');
        const batch = lines.slice(-20).join('\n').slice(0, 300);
        if (batch) {
          emit({ kind: 'thought', summary: batch });
        }
        pending = '';
        lastThought = now;
      }
    };
    const mcp = await serveTools(task.tools, {
      maxCalls: task.maxSteps,
      onCall(name, input, result, ms) {
        steps++;
        emit({ kind: 'tool-call', summary: `Called ${name}.`, tool: name, input });
        const output = result.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
        emit({
          kind: 'tool-result',
          summary: result.meta?.summary ?? `${name}: ${firstLine(output)}`,
          tool: name,
          output: output.slice(0, 500),
          screenshot: result.meta?.screenshot,
          screenId: result.meta?.screenId,
          durationMs: ms,
          costUsd: 0,
        });
        if (result.done) {
          summary = output;
          finished = true;
        }
      },
    });
    try {
      const promptFile = join(temp, 'prompt.md');
      const mcpFile = join(temp, 'mcp.json');
      const prompt = `${task.system}\n\n${task.prompt}`;
      await writeFile(promptFile, prompt);
      await writeFile(mcpFile, JSON.stringify({ mcpServers: { bugpatrol: { type: 'http', url: mcp.url } } }));
      // A role with no worktree acts only through the tools, so it starts in
      // a directory with nothing in it to read but its prompt.
      const workdir = task.workdir ?? temp;
      const replacements = {
        prompt: promptFile,
        mcp: mcpFile,
        mcpUrl: mcp.url,
        workdir,
      };
      const command = this.use.command.replace(/\{(prompt|mcp|mcpUrl|workdir)\}/g, (_, name: string) => {
        return quote(replacements[name as keyof typeof replacements]);
      });
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: workdir,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let inputError: string | undefined;
      // Commands may read {prompt} from disk and close stdin before this write.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') inputError = `Prompt input failed: ${error.message}`;
      });
      child.stdin.end(prompt);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        onText(chunk.toString());
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        onText(chunk.toString());
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        }
      }, task.timeoutMs);
      let code: number | null;
      try {
        code = await new Promise<number | null>((done, reject) => {
          child.once('error', reject);
          child.once('exit', done);
        });
      } finally {
        clearTimeout(timer);
      }
      if (partial) pending += displayLine(partial);
      if (pending.trim()) {
        emit({ kind: 'thought', summary: pending.trim().slice(0, 300) });
      }
      const parsed = parseCliOutput(stdout);
      if (parsed.tokens) {
        const model = parsed.model ?? this.label;
        emit({
          kind: 'usage',
          summary: `${model}: ${formatUsage(parsed.tokens)}`,
          tokens: parsed.tokens,
          model,
          costUsd: 0,
        });
      }
      const text = parsed.text.trim().split('\n').slice(-20).join('\n');
      // claude prints its result only inside the final JSON, so the feed has not seen it yet.
      if (parsed.model && text) emit({ kind: 'thought', summary: text.slice(0, 300) });
      if (timedOut) {
        return {
          stop: 'timeout',
          steps,
          costUsd: 0,
          summary: summary || text,
          finished,
        };
      }
      if (code !== 0 || inputError) {
        return {
          stop: 'error',
          steps,
          costUsd: 0,
          error:
            inputError ||
            parsed.error ||
            stderr.trim().split('\n').slice(-20).join('\n') ||
            text ||
            `CLI exited ${code}`,
        };
      }
      if (parsed.error) {
        return { stop: 'error', steps, costUsd: 0, error: parsed.error, summary: summary || text, finished };
      }
      return {
        stop: 'done',
        steps,
        costUsd: 0,
        summary: summary || text,
        finished,
      };
    } finally {
      await mcp.close();
      await rm(temp, { recursive: true, force: true });
    }
  }
}
