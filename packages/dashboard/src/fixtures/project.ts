import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, type SessionFlow } from '@bugpatrol/core';
import { writeAgentFixture } from './agent-workspace.js';
import { writeCoverageFixture } from './coverage.js';

/** A project that tests a client app, a backend, or both from one repo. */
export type ProjectShape = 'client' | 'api' | 'monorepo';

const CLIENT_CONFIG = `version: 1
app:
  platform: electron
  start: npm start
logs:
  - name: api
    kind: file
    path: logs/api.log
`;

const API_CONFIG = `version: 1
app:
  platform: api
  connect:
    url: http://127.0.0.1:4010
    spec: openapi.json
`;

/**
 * Write a whole project of one shape: its config files and the data of its
 * patrols. A monorepo has `bugpatrol.yml` for the desktop app and `api.yml`
 * for its backend, and both write to the same `.bugpatrol/runs/`.
 */
export function writeProjectFixture(root: string, shape: ProjectShape): void {
  mkdirSync(paths.dir(root), { recursive: true });
  if (shape !== 'api') {
    writeFileSync(join(paths.dir(root), 'bugpatrol.yml'), CLIENT_CONFIG);
    writeAgentFixture(root);
    writeFlowFixture(root);
  }
  if (shape !== 'client') {
    writeFileSync(join(paths.dir(root), shape === 'api' ? 'bugpatrol.yml' : 'api.yml'), API_CONFIG);
    writeCoverageFixture(root);
  }
}

/** The flow of the finished explorer session: an action, the request that failed, and the log after it. */
function writeFlowFixture(root: string): void {
  const at = (seconds: number) => new Date(Date.now() - 125 * 60_000 + seconds * 1000).toISOString();
  const flow: SessionFlow = {
    version: 1,
    sessionId: 'ses_done',
    role: 'explorer',
    startedAt: at(0),
    endedAt: at(1800),
    sources: [{ name: 'api', kind: 'file', collected: 2 }],
    entries: [
      { at: at(10), kind: 'action', label: 'explorer', summary: 'Opened Projects.' },
      { at: at(12), kind: 'request', label: 'GET /items/0', summary: 'GET /items/0 failed with 500.' },
      {
        at: at(12.4),
        kind: 'log',
        label: 'api',
        level: 'error',
        summary: 'Division by zero in item lookup.',
        correlated: true,
      },
      { at: at(40), kind: 'action', label: 'explorer', summary: 'Opened Settings.' },
      { at: at(95), kind: 'log', label: 'api', level: 'warn', summary: 'Slow query: 812 ms.' },
    ],
  };
  writeFileSync(paths.sessionFlow(root, 'ses_done'), JSON.stringify(flow, null, 2));
}
