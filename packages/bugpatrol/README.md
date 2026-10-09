<p align="center">
  <img src="https://raw.githubusercontent.com/agent-labs-dev/bugpatrol/main/assets/banner.png" alt="Bugpatrol: AI agents that explore your app, find bugs, and fix them." width="100%">
</p>

Bugpatrol is a QA team made of agents. It uses your web, Electron, iOS, Android or desktop app, HTTP API or CLI the way a tester does. It finds bugs, fixes them, checks each fix in the running app, and opens the pull requests and issues for your team.

```sh
npx bugpatrol init         # find the app and the LLMs, and write .bugpatrol/
npx bugpatrol              # explore, judge, fix, retest, and publish, again and again
npx bugpatrol dashboard    # look at the results on http://127.0.0.1:4311
```

## Set up with your agent

Install the skill for your coding agent, then ask the agent to "set up Bugpatrol for this repo":

```bash
npx skills add agent-labs-dev/bugpatrol
```

If your agent cannot install skills, give it the skill URL:

```text
Read https://raw.githubusercontent.com/agent-labs-dev/bugpatrol/main/skills/bugpatrol/SKILL.md and set up Bugpatrol for this repo.
```

## Documentation

- [README](https://github.com/agent-labs-dev/bugpatrol#readme)
- [Getting started](https://github.com/agent-labs-dev/bugpatrol/blob/main/docs/getting-started.md)
- [Configuration](https://github.com/agent-labs-dev/bugpatrol/blob/main/docs/configuration.md)
- [Commands](https://github.com/agent-labs-dev/bugpatrol/blob/main/docs/commands.md)

The [Nebula](https://nebula.gg) team uses Bugpatrol to test its own apps, and made it open source for all teams.

Made with ❤️ by the [Nebula](https://nebula.gg) team. Apache-2.0.
