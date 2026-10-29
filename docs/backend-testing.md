# Backend and native desktop patrols

Bugpatrol can test a backend in two ways. The web driver tests the backend
through a frontend: it sends a message, saves settings, or switches tenants.
The api platform (`app.platform: api`) sends HTTP requests to the backend
directly. Keep your own contract tests and worker tests next to the patrol.

## Test an HTTP API

Bugpatrol does not start a backend. It tests a backend that runs already, on
your machine or on a deployed server. Start with `init`:

```sh
npx bugpatrol init --platform api --url http://127.0.0.1:8000 --spec /openapi.json
```

`init` writes `connect.url`, `connect.spec`, and an empty `deny`. The other api
keys are comments in the file. Turn on each key that your API needs:

```yaml
app:
  platform: api
  setup: []                     # Bugpatrol starts nothing
  connect:
    url: http://127.0.0.1:8000
    spec: /openapi.json         # a URL, a path on url, or a file in the project
    deny: ['/admin/**', 'POST /billing/**']
    errors: { statuses: [401, 403, 404], schema: { type: object, required: [error] } }
    credentials:
      self: { headers: { Authorization: 'Bearer ${SESSION_TOKEN}' } }
      other: { headers: { Authorization: 'Bearer ${OTHER_TOKEN}' } }
    version: { path: /version, pointer: /commit }
  secrets: [SESSION_TOKEN, OTHER_TOKEN]
```

[Configuration](configuration.md#connect-for-an-api) gives each key and its
default. Bugpatrol never uses the `servers` value of a spec: each request goes
to `connect.url`. Run `bugpatrol endpoints` to see the endpoints that Bugpatrol
reads from the spec, and the reason for each endpoint that it skips.

[examples/api-fixture](../examples/api-fixture) is a small backend with planted
bugs, and [examples/review-smoke-api](../examples/review-smoke-api) is its
config. The `api` job of `.github/workflows/review-smoke.yml` runs both on each
pull request.

### The sweep

`bugpatrol sweep` tests each endpoint with no model. It makes a set of cases for
each endpoint from the spec: a request that must succeed, and negative cases
such as no credentials, a bad body, a missing id, the data of another user,
and a second delete. Bugpatrol checks each response against the spec: the
status, the content type, and the body schema.

For a missing id, Bugpatrol changes a known id and keeps its shape: the
prefix, the length, and the character classes. Without a known id, the made-up
id can have a wrong format, so a declared 400 or 422 also passes.

Bugpatrol sends each failed case a second time. Only a failure that repeats
blocks: `bugpatrol sweep` then exits 1. A failure that does not repeat goes to
the judge as a candidate that does not block. When the user `other` gets a 2xx
for the data of `self`, the finding also does not block. The data can be shared
with all users, so the judge decides. A run stops at
`agents.sweep.maxRequests`, and the next run continues from that case.

The patrol runs the sweep first in each explorer session of an api app. Then
the explorer tests the endpoints with a model. It starts with the endpoints
that have no coverage, and with the failures that did not repeat. The judge
reads the candidates of both, and it files one issue for each failure.
The issue key is the endpoint, the case, and the failed check, so the same
failure in a later run adds to its issue.

### The request policy

All requests go through one request policy:

- Writes go out only to a loopback URL (`127.0.0.0/8`, `[::1]`, `localhost`),
  or when `disposable: true`. Any other target gets only GET, HEAD, and OPTIONS.
- `methods` makes the allowed methods fewer. It never adds a method.
- Bugpatrol never requests an endpoint in `deny`, or an operation that the spec
  marks with `x-bugpatrol-skip`. A deny glob matches a path template, with an
  optional method: `*` is one segment, and `**` is any number of segments.
- A URL that matches no endpoint of the spec can only read.
- Bugpatrol sends at most `perMinute` requests in one minute. After a 429, it
  waits for `Retry-After` and tries one more time. A 429 is never a bug.

`bugpatrol endpoints` shows each endpoint as `allowed`, `read-only`, or
`denied: <reason>`. `bugpatrol sweep --dry-run` lists the requests that the
sweep plans, and it sends nothing.

### Errors

Many specs declare few error responses. `connect.errors` lists the error
statuses that each endpoint can return, and the JSON Schema of the error body.
The sweep makes a negative case only for a status that the spec or
`connect.errors` declares. When the spec does not declare a status of an
endpoint, and `connect.errors` has it, the body must match `connect.errors.schema`.

When a spec declares no error status other than 422 on most of its operations,
Bugpatrol gives one finding on the spec. It does not give one finding for each
endpoint. Set `connect.errors` to get the negative cases on such an API.

### Credentials

A credential set is the headers of one user. `self` is the main user, and
`other` is a second user. Each set keeps its token and its workspace header
together, and `connect.headers` goes into each set. Without `credentials`,
`connect.headers` is the only set.

The second user enables the cross-user cases: the user `other` requests the
data of `self`, and the API must refuse it. Without `other`, Bugpatrol blocks
these cases. Without a credential header, Bugpatrol blocks the no-auth cases
too.

A path parameter with the name of a credential header gets the value of that
header. For example, `X-Workspace-Id` fills `{workspace_id}`.

Write each token as a `${NAME}` placeholder. The name must be in `app.secrets`,
or a setup step must capture it. A setup step can get a short-lived token, for
example with `capture`. Bugpatrol redacts each credential from the evidence,
the logs, and the issues.

### Deploys

An api app with no `background` setup step is an external backend. Only a
deploy changes its code. `connect.version` tells Bugpatrol which commit runs:

```yaml
connect:
  version:
    path: /version/fleet
    pointer: /result/*/commit   # `*` takes each element of an array
```

A patrol explores and judges again only when that commit changes. A fleet
counts only when each process reports the same commit. A mixed fleet or a
missing commit waits. Bugpatrol does not retest a fix before its merge. After
the merge, the issue is `waits-for-deploy` until the deployed commit contains
the merge commit (a squash commit too). Then Bugpatrol checks the fix. Without
`connect.version`, the issue waits, and each patrol checks it. Only a pass
counts, so Bugpatrol never marks a fix as failed.

### CI and the state branch

A patrol in CI starts with an empty `.bugpatrol/runs/`. With
`agents.patrol.state: branch` (or `bugpatrol patrol --state branch`), the patrol
keeps its JSON state on the `bugpatrol-state` branch. The state includes the
issues, the triage, the coverage, and the last tested commit. The patrol pulls
the branch before each cycle and pushes it after the cycle. A dev machine with
the same setting shares the state with CI. No run commits to `main`.

The Bugpatrol Action with `mode: patrol` runs one cycle in this mode. Refer to
[Patrol on a schedule](../README.md#patrol-on-a-schedule).

### The coverage matrix

The sweep writes `.bugpatrol/runs/coverage.json`. The **Coverage** page of the
dashboard shows it as a matrix: one row for each endpoint, and one column for
each case. A cell shows the status and the result. Click a cell to see the HTTP
exchange behind it. The matrix also shows the endpoints that the policy or the
spec skips, with the reason, and the cases that no run tested yet.

### Evidence and routines

The evidence of an API is text, not a screenshot
([ADR 0008](adr/0008-api-evidence-is-text.md)). Each request gives an HTTP
exchange: the request line, the headers that the step set, the status, the
allowed response headers, the body, and the latency. The api driver starts no
browser. The models, the issues, and the dashboard show the same text. A body
over 1 MiB is not kept: the evidence records its size. Requests stay on the
configured origin, and Bugpatrol does not follow redirects.

The explorer's `request` tool takes a method, a relative URL, optional headers,
a string body, and `as` (`self`, `other`, or `none`). To use an id that a
request created, add `capture: {RESPONSE_ITEM_ID: "/result/id"}` to the
request. Then use `{{RESPONSE_ITEM_ID}}` in the next URLs and bodies. Each
replay gets a new value. A capture holds an identifier, not a secret: it
cannot replace a setup variable or a credential. Bugpatrol never guesses that
a literal value is an id.

## Run a disposable stack

Put Bugpatrol's config in the repository whose code you intend to investigate.
Use `app.setup` to prepare an isolated database and cache, migrate them, start
the backend and frontend, and create a disposable account. Point the frontend
at that backend explicitly; a local frontend using a production API is not an
isolated test.

Setup commands can capture dynamic URLs and a short-lived login session:

```yaml
app:
  platform: web
  source: .
  setup:
    - run: ./scripts/prepare-patrol-stack
      capture:
        WEB_URL: 'WEB_URL=(http://[^\s]+)'
    - run: ./scripts/start-patrol-api
      background: true
      readyWhen: 'API ready'
    - run: ./scripts/start-patrol-web
      background: true
      readyWhen: 'Web ready'
    - run: ./scripts/seed-patrol-user
      capture:
        SESSION_TOKEN: 'SESSION_TOKEN=([^\s]+)'
  connect:
    url: '${WEB_URL}'
  instructions: .bugpatrol/instructions.md
```

These commands are application-owned examples, not built-in commands. Supply
the rest of the configuration from `bugpatrol init`; see [configuration](configuration.md).
Describe your development-only session handoff in `instructions.md`, using
`{{SESSION_TOKEN}}` where needed. Never give the explorer backend service keys.
Captured variables are redacted from setup reporting, but browser state and
screenshots remain sensitive. Keep run artifacts private and ignored.

Start with the fixer and GitHub agent disabled and `agents.patrol.pull: false`
while investigating a feature checkout. Run a short `explore`, inspect its
coverage, then a longer `explore` and `judge`. A successful greeting is evidence
for that flow; it does not establish tenant isolation or worker reliability.

## Give the explorer observable consequences

Seed two tenants with distinguishable content. Ask the explorer to switch
between them, create content, reopen it, reload, cancel a running operation,
and verify settings persist. Define prohibited actions such as payments,
external messages, real integrations, and production device provisioning.

The web driver reports failed fetch/XHR/document requests and console errors.
Use those to investigate, then confirm the user-visible consequence and trace
the failure in backend logs. A cancelled stream during navigation alone is not
proof of broken persistence. Supply a separate backend trace or direct API
reproduction when the UI cannot distinguish the suspected failure.

Background setup processes stop when the session ends. Explicitly tear down
datastores and remove development identity-provider users using your own
lifecycle tooling; process shutdown does not delete those resources.

## Visible native sessions

Use `app.platform: desktop` on Linux to launch an app in its own Xvfb display,
DBus session, HOME and XDG directories. This isolates keyboard focus from the
user's desktop; it is not a filesystem or network sandbox. App setup remains
on the host; only disposable app credentials should reach the launched app.
The driver uses the installed Cua binary through a run-owned `mcp --direct`
transport and never connects to or stops a shared daemon.

```yaml
app:
  platform: desktop
  connect:
    cua:
      command: cua-driver
      windowManager: openbox
      launch: /absolute/path/to/app
      args: ['--user-data-dir={{PRIVATE_DIR}}/profile']
      windowTitle: My App          # required if several initial windows match
      deliveryMode: foreground    # explicit; defaults to background
      viewer:
        enabled: true
        port: 0                   # loopback only; choose an available port
        allowTakeover: false
```

Prerequisites: Linux, `setsid`, `xvfb-run`, `xauth`, `dbus-run-session`, Openbox,
AT-SPI bus launcher/registry, and Cua with window capture and input tools.
Chromium additionally needs `--force-renderer-accessibility`. Cua refuses
Chromium's X11 background input; explicitly select foreground delivery inside
the private display. There is no automatic fallback to the shared desktop.
Apps must support a separate instance/profile. `{{PRIVATE_DIR}}` expands only
in trusted launch arguments and is removed on close.

The viewer serves authenticated captures on loopback, with input disabled by
default. Its capability URL is saved privately in
`.bugpatrol/runs/desktop-viewer.json`; the terminal prints only its tokenless
address. Do not share the capability or screenshots. The browser displays
images of the app rather than a window that can receive host input.

Opting into `allowTakeover: true` adds a Take over button. Takeover waits for
in-flight input, pauses agent operations, and admits user input only while the
human owns control. Both ownership changes and human actions are traced;
typed user text is not logged. Returning to the agent invalidates stale refs
and starts a new replay trail. A pending action fails until the agent looks
again. Captures from the viewer never replace the agent's observation, and
semantic targets are refreshed before delivery to avoid stale Cua tokens.
Missing or ambiguous semantic targets fail; there is no silent point fallback.
For controls without accessibility, `tap_point` takes an explicit point in the
latest screenshot and records degraded replay. A resized window requires a
fresh observation before any point action.

Shutdown stops the viewer, closes the run's MCP transport, kills its private
process group, and removes temporary profiles. It never calls `cua-driver stop`.

Run real native qualification after installation:

```sh
BUGPATROL_CUA_E2E=1 BUGPATROL_CUA_COMMAND=/path/to/cua-driver \
  pnpm exec vitest run packages/drivers/src/cua
```

Normal CI covers the viewer/ownership boundaries without native prerequisites;
the real native test is explicitly skipped unless that flag is set.
