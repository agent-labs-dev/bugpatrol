import type { AgentRole } from '../types/agents.js';

/**
 * Local agent CLIs that can run a role (ADR 0005). A preset is the command a
 * role needs: the explorer and the judge act only through the Bugpatrol MCP
 * tools, so their command loads `{mcp}`, pre-approves those tools, and, where
 * the CLI allows it, turns its own file and shell tools off. The
 * fixer edits files and runs the repo's tests in its worktree, so its command
 * uses the CLI's auto permission mode, or skips the prompts when the CLI has
 * no auto mode.
 *
 * `use: claude` in bugpatrol.yml expands to the preset for that role. A
 * `command` wins over the preset, for teams that need extra flags.
 */
export const CLI_AGENTS = ['claude', 'codex', 'kimi', 'opencode', 'pi'] as const;
export type CliAgent = (typeof CLI_AGENTS)[number];

const PRESETS: Record<CliAgent, { tools: string; fixer: string }> = {
  claude: {
    tools:
      "claude -p --output-format json --tools '' --mcp-config {mcp} --strict-mcp-config --allowedTools mcp__bugpatrol",
    fixer: 'claude -p --output-format json --permission-mode auto',
  },
  // `-c` parses its value as TOML and keeps a bare URL as a string.
  // `--approve-for-me` is the codex auto mode, in the workspace-write sandbox.
  codex: {
    tools: 'codex exec --json --skip-git-repo-check -c mcp_servers.bugpatrol.url={mcpUrl} -',
    fixer: 'codex exec --json --skip-git-repo-check --approve-for-me -',
  },
  // Print mode approves tool calls on its own. The inline config gives kimi
  // only the URL, in the form its MCP loader expects.
  kimi: {
    tools: `kimi --quiet --mcp-config '{"mcpServers":{"bugpatrol":{"url":"'{mcpUrl}'"}}}'`,
    fixer: 'kimi --quiet --yolo',
  },
  // opencode ships two released lines with different flags and config shapes.
  // The `{opencode}` placeholder resolves to the installed line at spawn time
  // (packages/agents/src/runtime/opencode.ts). v1: no --standalone, config
  // keyed under mcp, permission map. v2: --standalone, mcp.servers, ordered
  // permissions list.
  opencode: {
    tools: '{opencode}',
    fixer: '{opencode}',
  },
  // pi has no MCP of its own: `--mcp-config` comes from the pi-mcp-adapter
  // extension (`pi install npm:pi-mcp-adapter`).
  pi: {
    tools: 'pi -p --no-session --mcp-config {mcp}',
    fixer: 'pi -p --no-session',
  },
};

export function cliPreset(agent: CliAgent, role: AgentRole): string {
  return role === 'fixer' ? PRESETS[agent].fixer : PRESETS[agent].tools;
}
