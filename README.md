<p align="center">
  <img src="assets/banner.png" alt="Bugpatrol: AI agents that explore your app, find bugs, and fix them." width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/bugpatrol"><img src="https://img.shields.io/npm/v/bugpatrol?color=a3e635&label=npm" alt="npm version"></a>
  <a href="https://github.com/agent-labs-dev/bugpatrol/actions/workflows/ci.yml"><img src="https://github.com/agent-labs-dev/bugpatrol/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
</p>

Bugpatrol is a QA team made of agents. It uses your web, desktop, or mobile app, HTTP API, or CLI the way a tester does. It finds bugs, fixes them, checks each fix in the running app, and opens the pull requests and issues for your team. The [Nebula](https://nebula.gg) team uses it every day on our own apps, and we made it open source for all teams.

- An **explorer** agent runs the app, maps its screens, and reports what looks wrong.
- A **judge** agent decides which reports are real bugs, and writes the issues.
- A **fixer** agent writes a fix in its own git worktree.
- The explorer and the judge **retest** each fix in the running app.
- Bugpatrol **publishes** to GitHub: a PR for each fix, and an issue for each major bug with no fix.

```bash
npx bugpatrol
```

`npx bugpatrol` runs the patrol: explore, judge, fix, retest, and publish, again and again. The fixer and GitHub stay off until you turn them on.

```mermaid
flowchart TB
  start(["npx bugpatrol"]) --> pull["Pull main and start the app"]
  pull --> explorer{{"1 · Explore<br/>LLM · Explorer uses the app"}}
  explorer -->|"bug reports"| judge

  judge["2 · Judge<br/>LLM · Judge files the issues"] --> fixer["3 · Fix<br/>LLM · Fixer writes a fix"]
  fixer --> retest["4 · Retest<br/>LLM · Explorer + Judge check the fix"]
  retest --> publish["5 · Publish<br/>LLM · Judge opens PRs and issues"]

  publish --> wait["Sync GitHub, then wait for a new commit on main"]
  wait -->|"next cycle"| pull

  subgraph legend ["Legend"]
    direction LR
    l1["LLM agent"] ~~~ l3["Code, no model"] ~~~ l4["Off by default"]
  end
  wait ~~~ legend

  classDef llm fill:#312e81,stroke:#a5b4fc,color:#ffffff
  classDef code fill:#1e293b,stroke:#64748b,color:#e2e8f0
  classDef opt fill:#312e81,stroke:#a5b4fc,color:#ffffff,stroke-width:2px,stroke-dasharray:6 4
  class explorer,judge,l1 llm
  class start,pull,wait,l3 code
  class fixer,retest,publish,l4 opt
  style legend fill:transparent,stroke:#64748b
```

[How it works](docs/how-it-works.md#the-patrol) tells when the patrol runs, and shows each step of the explore loop.

<img src="assets/dashboard.png" alt="The Bugpatrol dashboard: the status band, the issues and findings that need attention, and the live screen." width="100%">

<p align="center"><em>The dashboard (<code>npx bugpatrol dashboard</code>) shows what each agent does, live.</em></p>

## Set up with your agent

1. Install the Bugpatrol skill in your repo, and commit the skill and `skills-lock.json`:

   ```bash
   npx skills add agent-labs-dev/bugpatrol
   ```

2. Give this prompt to your agent:

   ```text
   Set up Bugpatrol for this repo.
   ```

If your agent cannot install skills, give it the skill URL:

```text
Read https://raw.githubusercontent.com/agent-labs-dev/bugpatrol/main/skills/bugpatrol/SKILL.md and set up Bugpatrol for this repo.
```

To set up Bugpatrol by hand, read [Getting started](docs/getting-started.md).

## What is supported

| Area | Supported |
| --- | --- |
| Platforms | Web (Playwright), Electron (CDP), iOS simulator and Android emulator (Maestro), Linux desktop apps through Cua and Xvfb, HTTP APIs and CLIs |
| Agent LLMs | Claude Code, Codex, Kimi CLI, opencode, pi, or any CLI agent; or an API key for OpenRouter, Vercel AI Gateway, OpenAI, Anthropic, or a custom endpoint |
| GitHub | PRs, issues, state sync, and pull request reviews in CI, through the `gh` CLI |
| Output | A local dashboard, GitHub PRs and issues, and JSON files under `.bugpatrol/runs/` |

## Documentation

| Page | What it covers |
| --- | --- |
| [Getting started](docs/getting-started.md) | The requirements, and the setup by hand, step by step |
| [Commands](docs/commands.md) | All the CLI commands |
| [Configuration](docs/configuration.md) | All the settings in `.bugpatrol/bugpatrol.yml` |
| [LLMs](docs/models.md) | The providers for each agent, and the model that we recommend for each agent |
| [The dashboard](docs/dashboard.md) | What each page shows, and the files behind it |
| [How it works](docs/how-it-works.md) | The patrol, the cycle, noise control, memory, and safety |
| [GitHub](docs/github.md) | PRs and issues, the state sync, and pull request reviews in CI |
| [The deterministic gate](docs/deterministic-gate.md) | `bugpatrol run`: a merge gate for web apps that uses no agent |
| [Development](docs/development.md) | Build Bugpatrol from source, the packages, and the examples |
| [Bughunters](docs/bughunters.md) | The earlier name of Bugpatrol, and how to move a repo to the new names |

## License

[Apache-2.0](LICENSE)

---

<p align="center">Made with ❤️ by the <a href="https://nebula.gg">Nebula</a> team.</p>
