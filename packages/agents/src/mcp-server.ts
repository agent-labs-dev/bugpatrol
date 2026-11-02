import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { handsBack, type Tool, type ToolResult } from './types.js';

type Options = {
  /** `step` is false for a call that used no step: a hand-back tool, or one refused for the budget. */
  onCall?: (name: string, input: Record<string, unknown>, result: ToolResult, ms: number, step: boolean) => void;
  maxCalls?: number;
};

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * Serves a role's tools to a CLI agent (ADR 0005). The server is stateless:
 * each HTTP request gets its own MCP server and transport, because a
 * stateless transport accepts only one initialize. The call budget lives out
 * here, so it holds across every client session the CLI opens.
 */
export async function serveTools(tools: Tool[], opts: Options = {}): Promise<{ url: string; close(): Promise<void> }> {
  const budget = { calls: 0 };

  const http = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    void handle(request, response, tools, opts, budget).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500).end(String(error));
      }
    });
  });

  await new Promise<void>((done, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      done();
    });
  });

  const address = http.address();
  if (!address || typeof address === 'string') {
    throw new Error('MCP server did not bind');
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  tools: Tool[],
  opts: Options,
  budget: { calls: number },
): Promise<void> {
  const server = buildServer(tools, opts, budget);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}

function buildServer(tools: Tool[], opts: Options, budget: { calls: number }): Server {
  const server = new Server({ name: 'bugpatrol', version: '0.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const input = request.params.arguments ?? {};
    const started = Date.now();
    const before = budget.calls;
    const result = await callTool(tools, name, input, opts, budget);
    opts.onCall?.(name, input, result, Date.now() - started, budget.calls > before);
    return { content: result.content.map(toMcp), isError: result.isError ?? false };
  });

  return server;
}

async function callTool(
  tools: Tool[],
  name: string,
  input: Record<string, unknown>,
  opts: Options,
  budget: { calls: number },
): Promise<ToolResult> {
  // An agent out of steps can still report what it found, and hand back.
  if (!handsBack(name) && budget.calls >= (opts.maxCalls ?? Infinity)) {
    const text = tools.some((tool) => tool.name === 'report_bug')
      ? 'The step budget is used. Report each bug that you found and did not report yet with report_bug, then call finish.'
      : 'The step budget is used. Call finish now.';
    return { content: [{ type: 'text', text }], isError: true };
  }
  if (!handsBack(name)) {
    budget.calls++;
  }

  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  }
  try {
    return await tool.run(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}

function toMcp(part: ToolResult['content'][number]): McpContent {
  if (part.type === 'text') return { type: 'text', text: part.text };
  return { type: 'image', data: part.png.toString('base64'), mimeType: 'image/png' };
}
