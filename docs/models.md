# LLMs

Bugpatrol has three LLM agents. They use the app, decide which reports are real bugs, and write the fixes.

## What each agent does

| Agent | What it does | When it runs |
| --- | --- | --- |
| Explorer | Uses the app, maps its screens, and reports what looks wrong. Learns lessons after each session | Each `explore`, each retest |
| Judge | Looks at each finding and its screenshot. Files an issue, or dismisses the finding with a reason. Compares the before and after screenshots of a fix. Writes the PR and issue summaries | Each `judge`, each retest, each `publish` |
| Fixer | Reads the issue and the code, and writes a fix in its own git worktree | Each `fix` |

## Which model for each agent

Each agent needs different skills. Give the judge your strongest model. Give the explorer a fast, low-cost model.

- **Explorer.** It runs a long loop of tool calls, with a screenshot after each step. It needs good vision, computer use, and reliable tool calls. It uses the most tokens of the three agents, so cost and speed are important. The judge checks each report, so the explorer does not need your strongest model.
- **Judge.** It makes fewer calls, but its decisions become GitHub issues and PRs. It needs precision, fine visual detail to compare the screenshots before and after a fix, product sense, and clear writing. Use your strongest model with vision.
- **Fixer.** It reads the code and edits it in a worktree. Use a strong coding model in an agent CLI.

The prices are the OpenRouter list prices in USD for each million input / output tokens, in September 2026.

### Explorer

| Lab | Model | `use:` | Price |
| --- | --- | --- | --- |
| Anthropic | Claude Sonnet 5 | `{ runtime: model, via: anthropic, model: claude-sonnet-5 }` | $2 / $10 |
| OpenAI | GPT-6 Luna | `{ runtime: model, via: openai, model: gpt-6-luna }` | $0.10 / $0.50 |
| Google | Gemini 3.8 Flash | `{ runtime: model, via: openrouter, model: google/gemini-3.8-flash }` | $0.75 / $3.75 |

The OpenRouter default, `z-ai/glm-5.3-flash`, is also a good low-cost explorer.

### Judge

| Lab | Model | `use:` | Price |
| --- | --- | --- | --- |
| Anthropic | Claude Opus 5.5 | `{ runtime: model, via: anthropic, model: claude-opus-5-5 }` | $4 / $20 |
| OpenAI | GPT-6 Sol | `{ runtime: model, via: openai, model: gpt-6-sol }` | $2 / $10 |
| Moonshot AI | Kimi K3 | `{ runtime: model, via: openrouter, model: moonshotai/kimi-k3 }` | $3 / $15 |

### Fixer

| Lab | Agent CLI and model | `use:` |
| --- | --- | --- |
| Anthropic | Claude Code, with Claude Opus 5.5 | `claude`, and add `--model claude-opus-5-5` |
| OpenAI | Codex, with GPT-6 Astra | `codex`, and add `-m gpt-6-astra` |
| Moonshot AI | Kimi CLI, with Kimi K3 | `kimi`, with Kimi K3 as the model in the Kimi CLI config |

To set the model of a CLI, write the full preset command, and add the model flag:

```yaml
agents:
  fixer:
    use:
      runtime: cli
      command: claude -p --output-format json --permission-mode auto --model claude-opus-5-5
```

The [presets](../packages/core/src/config/agents.ts) show the full command for each CLI and role.

## LLM providers for each agent

Each agent (explorer, judge, fixer) needs an LLM. Each agent can use a different provider. Set it in `agents.<role>.use`.

### A local agent CLI

A local agent CLI uses your existing login, so you do not need an API key. Bugpatrol has presets for these CLIs:

| `use:` | CLI | Notes |
| --- | --- | --- |
| `claude` | [Claude Code](https://claude.com/claude-code) | |
| `codex` | [Codex CLI](https://github.com/openai/codex) | |
| `kimi` | [Kimi CLI](https://github.com/MoonshotAI/kimi-cli) | |
| `opencode` | [opencode](https://opencode.ai) | |
| `pi` | [pi](https://github.com/badlogic/pi-mono) | Needs MCP: `pi install npm:pi-mcp-adapter`. With `pi-permission-modes`, add `--perm yolo` |

```yaml
agents:
  explorer: { use: claude }
  judge: { use: claude }
  fixer: { use: codex }
```

The preset gives each role the correct flags. The explorer and the judge act only through the Bugpatrol tools, which Bugpatrol gives to the CLI over MCP. They start in an empty temporary directory, and the `claude` preset turns off the built-in Claude Code tools with `--tools ''`, so neither role can read or run anything on the host. Other CLIs keep their own tools; the empty directory is their only limit. The fixer edits files and runs commands in its own worktree. It uses the auto permission mode of its CLI: `--permission-mode auto` for claude, `--approve-for-me` for codex, and `--auto` for opencode. A CLI with no auto mode skips the prompts: `--yolo` for kimi, and `--perm yolo` for pi with pi-permission-modes.

To add flags, write the full command. A command gets the prompt on stdin and in `{prompt}` (a file). It gets the tools in `{mcp}` (an MCP config file) or `{mcpUrl}`, and the worktree in `{workdir}` (an empty temporary directory for the explorer and the judge):

```yaml
agents:
  judge:
    use:
      runtime: cli
      command: claude -p --output-format json --model sonnet --tools '' --mcp-config {mcp} --strict-mcp-config --allowedTools mcp__bugpatrol
```

Keep `--output-format json` for `claude` and `--json` for `codex`. With these flags, the CLI reports its token usage, and the dashboard shows it. Without them, the dashboard shows no tokens for that agent.

### An API key

The built-in model loop calls a provider directly:

| `via` | Environment variable | Get a key | Default model |
| --- | --- | --- | --- |
| `openrouter` | `OPENROUTER_API_KEY` | https://openrouter.ai/keys | `z-ai/glm-5.3-flash` |
| `vercel` | `AI_GATEWAY_API_KEY` | https://vercel.com/ai-gateway | set `model` |
| `openai` | `OPENAI_API_KEY` | https://platform.openai.com/api-keys | set `model` |
| `anthropic` | `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys | set `model` |
| `custom` | `BUGPATROL_MODEL_API_KEY` | your provider | set `model` and `endpoint` |

```yaml
agents:
  explorer:
    use: { runtime: model, via: openrouter, model: z-ai/glm-5.3-flash }
  judge:
    use: { runtime: model, via: anthropic, model: claude-opus-5-5 }
```

`bugpatrol init` writes a default model for each provider. We recommend OpenRouter or Vercel AI Gateway: one key gives you many models.

## Check the setup

Before an agent command starts the app, Bugpatrol checks each agent that the command uses. If a key is not set, or a CLI is not on `PATH`, the command stops and tells you what to do.
