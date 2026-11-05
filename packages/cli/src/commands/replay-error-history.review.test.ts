import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@bugpatrol/agents';
import { parseConfig } from '@bugpatrol/core';
import type { DriverAction } from '@bugpatrol/drivers';
import { expect, it, vi } from 'vitest';
import { FakeDriver } from '../../../agents/src/testing/fake-driver.js';
import { runAgentCommand } from './agents.js';

const state = vi.hoisted(() => ({ driver: undefined as unknown }));
vi.mock('@bugpatrol/drivers', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createDriver: () => state.driver,
}));

it('fails replay when an optional missing banner consumes the reproduced console error', {
  timeout: 20000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-error-history-'));
  class ErrorDriver extends FakeDriver {
    private pending = ['TypeError: broken dashboard'];
    override async observe() {
      return { ...(await super.observe()), consoleErrors: this.pending.splice(0) };
    }
    override async act(action: DriverAction) {
      if (action.kind === 'tap') return { ok: false, retryable: true, error: 'Optional banner is absent' };
      return super.act(action);
    }
  }
  state.driver = new ErrorDriver({
    home: {
      elements: [
        {
          ref: 'heading',
          role: 'heading',
          name: 'Dashboard',
          box: { x: 0, y: 0, width: 50, height: 20 },
          interactive: false,
          enabled: true,
        },
      ],
    },
  });
  try {
    const config = parseConfig({ version: 1, app: { connect: { url: 'http://localhost:3000' } } });
    await new Workspace(root).saveRoutine({
      version: 1,
      id: 'repro-dashboard',
      platform: 'web',
      description: 'Dashboard logs an exception, with or without a dismissible banner',
      steps: [{ kind: 'tap', target: { role: 'button', name: 'Dismiss banner' } }],
      expect: { elements: ['Dashboard'] },
      bug: { error: 'TypeError: broken dashboard' },
      createdAt: 'now',
      updatedAt: 'now',
    });
    await expect(runAgentCommand('replay', ['repro-dashboard'], root, config, () => {})).rejects.toThrow('still shows');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
