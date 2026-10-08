# The fixture app

The app under test is the fixture app at http://localhost:3300/. It has two pages: Home (`index.html`) and Settings (`settings.html`), served by `server.js`.

## What this app is made of

Only the files in `examples/fixture-app/`. Nothing else in this repo runs in it.

## What is not this app

This repo is Bugpatrol. Everything outside `examples/fixture-app/` is Bugpatrol's own code: `packages/`, `docs/`, `.github/`, and the other `examples/` folders. This app never runs it, and other jobs review it (`review-smoke-dashboard` and `review-smoke-cli`). Only localhost:3300 is up here. Do not look for the dashboard, the CLI, or any other server or port.

When the pull request changes nothing in `examples/fixture-app/`, check that Home and Settings load, then finish. Put the two pages in tested, and in untested write "The rest of the change: outside the fixture app".
