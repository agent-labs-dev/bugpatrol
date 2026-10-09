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
  // opencode reads extra config from the environment: the inline config adds
  // the Bugpatrol MCP server and denies every other tool.
  opencode: {
    tools: `OPENCODE_CONFIG_CONTENT='{"mcp":{"servers":{"bugpatrol":{"type":"remote","url":"'{mcpUrl}'","oauth":false}}},"permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"bugpatrol_*","resource":"*","effect":"allow"},{"action":"execute","resource":"*","effect":"allow"}]}' opencode run --standalone --auto --format json`,
    fixer: 'opencode run --standalone --auto --format json',
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
