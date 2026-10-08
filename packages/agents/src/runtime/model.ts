import { type AgentEvent, ConfigError, type RoleRuntime, usageFrom } from '@bugpatrol/core';
import { MODEL_KEYS, MODEL_ROUTES } from '@bugpatrol/decide';
import type { EventSink, RoleOutcome, RoleTask, Runtime, ToolResult } from '../types.js';

type ModelUse = Extract<RoleRuntime, { runtime: 'model' }>;
type Message = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string };
type ResponsePayload = Record<string, unknown>;
type Call = { id: string; name: string; input: Record<string, unknown>; invalidJson?: boolean };

function requestBody(use: ModelUse, task: RoleTask, messages: Message[], anthropic: boolean): unknown {
  if (anthropic) {
    return {
      model: use.model,
      max_tokens: 4096,
      system: task.system,
      messages,
      tools: task.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    };
  }
  return {
    model: use.model,
    messages,
    tools: task.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
    tool_choice: 'auto',
    ...(use.via === 'openrouter' ? { usage: { include: true } } : {}),
  };
}

function parseResponse(
  payload: ResponsePayload,
  anthropic: boolean,
): { text: string; calls: Call[]; assistantMessage: Message } {
  const choice = (
    payload.choices as
      | {
          message?: {
            content?: string;
            reasoning?: string;
            tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          };
        }[]
      | undefined
  )?.[0]?.message;
  const blocks = payload.content as
    | { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }[]
    | undefined;
  if (anthropic) {
    const text = (blocks ?? [])
      .filter((block) => block.type === 'text' || block.type === 'thinking')
      .map((block) => block.text ?? block.thinking ?? '')
      .join('\n');
    const calls = (blocks ?? [])
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} }));
    return { text, calls, assistantMessage: { role: 'assistant', content: blocks } };
  }
  const calls: Call[] = (choice?.tool_calls ?? []).map((call) => {
    try {
      const input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      return { id: call.id, name: call.function.name, input };
    } catch {
      return { id: call.id, name: call.function.name, input: {}, invalidJson: true };
    }
  });
  return {
    text: choice?.content ?? choice?.reasoning ?? '',
    calls,
    assistantMessage: {
      role: 'assistant',
      content: choice?.content ?? null,
      tool_calls: choice?.tool_calls,
    },
  };
}

function imageMessage(name: string, png: Buffer): Record<string, unknown>[] {
  return [
    { type: 'text', text: `Screenshot returned by ${name}` },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
  ];
}

function anthropicContent(part: ToolResult['content'][number]): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text };
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: part.png.toString('base64'),
    },
  };
}

/** The feed shows one line; the model already has the full text. */
export function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim()) ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** A note to the model. Anthropic wants it in the user turn that holds the tool results. */
function tell(messages: Message[], text: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user' && typeof last.content === 'string') {
    last.content = `${last.content}\n\n${text}`;
  } else if (last?.role === 'user' && Array.isArray(last.content)) {
    last.content.push({ type: 'text', text });
  } else {
    messages.push({ role: 'user', content: text });
  }
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function prune(messages: Message[]): void {
  let images = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || !Array.isArray(message.content)) {
      continue;
    }
    if (message.content.some((part: { type?: string }) => part.type === 'image_url' || part.type === 'image')) {
      images++;
      if (images > 2) {
        message.content = message.content.map((part: { type?: string }) =>
          part.type === 'image_url' || part.type === 'image'
            ? { type: 'text', text: '[earlier screenshot omitted]' }
            : part,
        );
      }
    }
  }
  if (messages.length > 40) {
    for (const message of messages.slice(0, -20)) {
      if (message.role === 'tool' && typeof message.content === 'string') {
        message.content = message.content.slice(0, 300);
      }
      if (message.role === 'user' && Array.isArray(message.content)) {
        message.content = message.content.map((part: { type?: string; content?: unknown }) =>
          part.type === 'tool_result' && typeof part.content === 'string'
            ? { ...part, content: part.content.slice(0, 300) }
            : part,
        );
      }
    }
  }
}

/** Provider calls and tool calls share one step budget, with history kept paired. */
export class ModelRuntime implements Runtime {
  readonly label: string;
  private readonly request: typeof fetch;

  constructor(
    private readonly use: ModelUse,
    options: { fetch?: typeof fetch } = {},
  ) {
    this.label = `model:${use.via}/${use.model}`;
    this.request = options.fetch ?? fetch;
  }

  async run(task: RoleTask, emit: EventSink): Promise<RoleOutcome> {
    const keyName = MODEL_KEYS[this.use.via];
    const apiKey = process.env[keyName];
    if (!apiKey) {
      throw new ConfigError(`Missing ${keyName} for ${this.label}`);
    }
    const endpoint = this.use.endpoint ?? MODEL_ROUTES[this.use.via].endpoint;
    if (!endpoint) {
      throw new ConfigError(`Missing endpoint for ${this.label}`);
    }
    const anthropic = this.use.via === 'anthropic';
    const messages: Message[] = anthropic
      ? [{ role: 'user', content: task.prompt }]
      : [
          { role: 'system', content: task.system },
          { role: 'user', content: task.prompt },
        ];
    const started = Date.now();
    const deadline = started + task.timeoutMs;
    let steps = 0;
    let costUsd = 0;
    let lastText = '';
    let textOnly = 0;
    // The steps are used: one more call with the finish tools only, so the agent hands back a
    // summary, as the CLI runtime lets it.
    let handBack: RoleTask | undefined;
    const outcome = (stop: RoleOutcome['stop'], summary?: string, error?: string): RoleOutcome => ({
      stop,
      steps,
      costUsd,
      summary,
      error,
    });
    for (;;) {
      if (steps >= task.maxSteps) {
        const finish = task.tools.filter((tool) => tool.name.startsWith('finish'));
        if (handBack || !finish.length) {
          return outcome('max-steps', lastText);
        }
        handBack = { ...task, tools: finish };
        tell(messages, 'Your steps are used. Call finish now with what you did and what you did not reach.');
      }
      const current = handBack ?? task;
      if (Date.now() - started >= task.timeoutMs) {
        return outcome('timeout', lastText);
      }
      prune(messages);
      const body = requestBody(this.use, current, messages, anthropic);
      let payload: ResponsePayload;
      try {
        payload = await this.call(endpoint, apiKey, anthropic, body, deadline);
      } catch (error) {
        if (Date.now() - started >= task.timeoutMs || (error instanceof Error && error.name === 'AbortError')) {
          return outcome('timeout', lastText);
        }
        return outcome('error', lastText, String(error));
      }
      steps++;
      const usage = payload.usage as
        | {
            cost?: number;
            input_tokens?: number;
            output_tokens?: number;
            prompt_tokens?: number;
            completion_tokens?: number;
          }
        | undefined;
      const stepCost = typeof usage?.cost === 'number' ? usage.cost : 0;
      costUsd += stepCost;
      const step = { tokens: usageFrom(usage), model: this.use.model ?? MODEL_ROUTES[this.use.via].model };
      const parsed = parseResponse(payload, anthropic);
      if (parsed.text) {
        lastText = parsed.text;
        emit({ kind: 'thought', summary: parsed.text.slice(0, 500) });
      }
      messages.push(parsed.assistantMessage);
      if (parsed.calls.length === 0) {
        emit({ kind: 'tool-result', summary: 'Model replied without a tool call.', costUsd: stepCost, ...step });
        textOnly++;
        if (textOnly >= 3) {
          return outcome('done', lastText);
        }
        tell(messages, 'Call one of the tools. Call finish when you are done.');
      } else {
        textOnly = 0;
        const calls = await this.runCalls(current, parsed.calls, emit, messages, anthropic, deadline, stepCost, step);
        if (calls.timeout) {
          return outcome('timeout', lastText);
        }
        if (calls.done) {
          return { ...outcome(handBack ? 'max-steps' : 'done', calls.output), finished: true };
        }
      }
      if (task.budgetUsd !== undefined && costUsd >= task.budgetUsd) {
        return outcome('budget', lastText);
      }
    }
  }

  private async runCalls(
    task: RoleTask,
    calls: Call[],
    emit: EventSink,
    messages: Message[],
    anthropic: boolean,
    deadline: number,
    stepCost: number,
    step: Pick<AgentEvent, 'tokens' | 'model'>,
  ): Promise<{ done?: boolean; timeout?: boolean; output?: string }> {
    const anthroResults: Record<string, unknown>[] = [];
    const images: Record<string, unknown>[] = [];
    for (const [index, call] of calls.entries()) {
      const tool = task.tools.find((item) => item.name === call.name);
      const started = Date.now();
      emit({ kind: 'tool-call', summary: `Called ${call.name}.`, tool: call.name, input: call.input });
      let result: ToolResult;
      let timer: NodeJS.Timeout | undefined;
      try {
        if (call.invalidJson) {
          result = { content: [{ type: 'text', text: 'Error: the arguments were not valid JSON' }], isError: true };
        } else if (!tool) {
          result = { content: [{ type: 'text', text: `Error: Unknown tool ${call.name}` }], isError: true };
        } else {
          result = await Promise.race([
            tool.run(call.input),
            new Promise<ToolResult>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Tool timed out')), Math.max(1, deadline - Date.now()));
            }),
          ]);
        }
      } catch (error) {
        if (Date.now() >= deadline) {
          emit({
            kind: 'tool-result',
            summary: `${call.name}: timed out`,
            tool: call.name,
            costUsd: index === 0 ? stepCost : undefined,
            ...(index === 0 ? step : {}),
            durationMs: Date.now() - started,
          });
          return { timeout: true };
        }
        result = { content: [{ type: 'text', text: `Error: ${String(error)}` }], isError: true };
      } finally {
        clearTimeout(timer);
      }
      const output = textOf(result);
      emit({
        kind: 'tool-result',
        summary: result.meta?.summary ?? `${call.name}: ${firstLine(output)}`,
        tool: call.name,
        output: output.slice(0, 500),
        screenshot: result.meta?.screenshot,
        screenId: result.meta?.screenId,
        costUsd: index === 0 ? stepCost : undefined,
        ...(index === 0 ? step : {}),
        durationMs: Date.now() - started,
      });
      if (anthropic) {
        anthroResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: result.isError ?? false,
          content: result.content.map(anthropicContent),
        });
      } else {
        messages.push({ role: 'tool', tool_call_id: call.id, content: output || '[image returned]' });
        for (const part of result.content) {
          if (part.type === 'image') {
            images.push(...imageMessage(call.name, part.png));
          }
        }
      }
      if (result.done) {
        if (anthropic) {
          messages.push({ role: 'user', content: anthroResults });
        }
        return { done: true, output };
      }
    }
    if (anthropic) {
      messages.push({ role: 'user', content: anthroResults });
    } else if (images.length) {
      messages.push({ role: 'user', content: images });
    }
    return {};
  }

  private async call(
    endpoint: string,
    apiKey: string,
    anthropic: boolean,
    body: unknown,
    deadline: number,
  ): Promise<ResponsePayload> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      try {
        const response = await this.request(endpoint, {
          method: 'POST',
          headers: anthropic
            ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) {
          return (await response.json()) as ResponsePayload;
        }
        if (response.status !== 429 && response.status < 500) {
          throw new Error(`Model returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
        }
        if (attempt === 2) {
          throw new Error(`Model returned ${response.status}`);
        }
      } catch (error) {
        if (
          attempt === 2 ||
          (error instanceof Error && (/^Model returned 4(?!29)/.test(error.message) || error.name === 'AbortError'))
        ) {
          throw error;
        }
      } finally {
        clearTimeout(timer);
      }
      if (Date.now() >= deadline) {
        throw new DOMException('Model timed out', 'AbortError');
      }
      await new Promise((done) =>
        setTimeout(done, Math.min([1000, 3000, 9000][attempt] ?? 0, Math.max(0, deadline - Date.now()))),
      );
    }
    throw new Error('Model request failed');
  }
}
