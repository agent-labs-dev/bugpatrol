# The Bugpatrol dashboard

The app under test is the dashboard of Bugpatrol, a QA team of AI agents, at http://127.0.0.1:4311/. It is read-only: it shows the files that the agents wrote, here a fixture workspace with made-up data.

- **Overview**: the agents, the issues that need a human, the live screen.
- **Issues**: a list on the left. Click an issue to see its detail: screenshots, steps, the judge's reasoning, and the proposed fix with its diff, fix attempts, and retests. The issue "Save button overlaps account text" has a fix.
- **Reviews**, **Activity**, **Flow**, **Screens**, **Memory**: the other pages, from the header.

The screenshots in the fixture are one-pixel images, so an empty or grey image is expected, not a bug. The page redraws when the workspace files change, which can close an open section.

## What this app is made of

- `packages/dashboard/`: the server (`src/*.ts`), the page (`src/ui/`), and the fixture data (`src/fixtures/`).
- The types and paths in `packages/core/` that the dashboard reads.
- The `dashboard` command in `packages/cli/`, which starts it.

## What is not this app

Everything else in this repo: the agents (`packages/agents/`), the other CLI commands, GitHub review comments, `docs/`, `.github/`, and `examples/`. Other jobs review the CLI (`review-smoke-cli`) and the fixture app (`review-smoke`). A change there shows on this page only when it changes what the dashboard reads. Do not run commands, and do not look for other servers or ports.

When the pull request changes nothing that this app is made of, check that the Overview and one issue detail load, then finish. In untested, write "The rest of the change: outside the dashboard".
