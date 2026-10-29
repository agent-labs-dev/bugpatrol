# Backend and native desktop patrols

Bugpatrol's web driver can test backend behavior exposed by a frontend: sending
a message, saving settings, switching tenants, or reopening persisted content.
For direct HTTP testing, use `app.platform: api` and the `request` tool. Keep
deterministic contract and background-worker tests alongside the patrol.

## Direct API patrols

```yaml
app:
  platform: api
  connect:
    url: http://127.0.0.1:8000
    headers:
      Authorization: 'Bearer ${SESSION_TOKEN}'
    spec: /openapi.json
    # Writes go out only to a loopback url, or when the data may be lost.
    disposable: false
    # Endpoints Bugpatrol never requests: globs on the spec's path templates.
    deny: ['/admin/**', 'POST /billing/**']
    perMinute: 60
    timeoutMs: 30000
```

Every request passes one request policy. A loopback url (`127.0.0.0/8`,
`[::1]`, `localhost`) or `disposable: true` allows writes; any other target is
read-only. `methods` narrows the allowed methods further. An endpoint in
`deny`, or marked `x-bugpatrol-skip` in the spec, is never requested. A URL
that matches no endpoint of the spec can only read. `bugpatrol endpoints`
shows each endpoint as `allowed`, `read-only`, or `denied: <reason>`.

A second user unlocks the cross-user cases. Each credential set keeps its
token and its workspace header together, and `headers` goes into both sets:

```yaml
    credentials:
      self: { headers: { Authorization: 'Bearer ${SESSION_TOKEN}', X-Workspace-Id: '${WORKSPACE}' } }
      other: { headers: { Authorization: 'Bearer ${OTHER_TOKEN}', X-Workspace-Id: '${OTHER_WORKSPACE}' } }
```

Without `credentials`, `headers` is the only set and the cross-user cases are
blocked. Without any credential header, the no-auth cases are blocked too.

Requests go out at most `perMinute` per minute. A 429 waits for its
`Retry-After` and tries one more time; it is never reported as a bug. An
event stream is cut after its headers.

Use the usual setup captures to provision a session. `request` accepts a method,
relative URL, optional headers, and a string body (use `Content-Type` for JSON).
Credentials use placeholders and replay preserves them. For entities created
within a routine, pass `capture: {RESPONSE_THREAD_ID: "/result/id"}` to `request`,
then use `{{RESPONSE_THREAD_ID}}` in subsequent URLs/bodies. Each replay refreshes
those ids. Captures accept JSON pointers to strings/numbers, cannot overwrite
setup/auth variables, and cannot expose redacted credential fields. Requests cannot leave
the configured origin and redirects are not followed, so credentials cannot
follow a redirect to another server. Request/response bodies are bounded to
1 MiB. A larger response body is not kept: the evidence records its size and
marks it as too large.

The evidence of an API is text, not a screenshot ([ADR 0008](adr/0008-api-evidence-is-text.md)).
Each request gives an HTTP exchange: the request line, the headers that the step
set, the status, the allowlisted response headers, the body, and the latency.
The api driver starts no browser. The models, the issues, and the dashboard show
the same text, and an issue shows it in an `http` block. Captured secrets,
credential headers, and credential fields in JSON are redacted. A 401 or 403 can
be correct behavior, not a bug.

`bugpatrol init --platform api --url http://127.0.0.1:8000` creates a starter.

### Deploys

An api app with no `background` setup step is an external backend: Bugpatrol
does not start it, so only a deploy changes its code. `connect.version` tells
Bugpatrol which commit runs:

```yaml
connect:
  version:
    path: /version/fleet
    pointer: /result/*/commit   # `*` takes each element of an array
```

A patrol explores and judges again only when that commit changes. A fleet
counts only when every process reports the same commit; a mixed fleet or a
missing commit waits. A fix is not retested before its merge. After the merge,
the issue is `waits-for-deploy` until the deployed commit contains the merge
commit (a squash commit too), and then Bugpatrol checks it. Without
`connect.version`, the issue waits, each patrol checks it, and only a pass
counts: a fix is never marked as failed.

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

Response captures hold non-secret identifiers, including numeric IDs. Use explicit
`{{RESPONSE_NAME}}` placeholders in subsequent routine steps; literal values are
never inferred as IDs. Configured/setup credentials and their historical values
remain redacted. Captures parse credential-sanitized JSON before evidence redaction.
