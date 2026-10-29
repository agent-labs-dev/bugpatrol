import { describe, expect, it } from 'vitest';
import { classifyAction } from './safety.js';

describe('classifyAction', () => {
  it('treats destructive copy as destructive', async () => {
    const r = await classifyAction({ selector: '#x', text: 'Delete workspace' }, { origin: 'http://localhost:3000' });
    expect(r.class).toBe('destructive');
  });

  it('treats an ambiguous button with no decider as destructive', async () => {
    // Skipping a safe button costs coverage. Clicking a destructive one costs
    // somebody their data.
    const r = await classifyAction({ selector: '#x', text: 'Apply' }, { origin: 'http://localhost:3000' });
    expect(r.class).toBe('destructive');
  });

  it('records an external link rather than following it', async () => {
    const r = await classifyAction(
      { selector: '#x', text: 'Docs', href: 'https://example.com/docs' },
      { origin: 'http://localhost:3000' },
    );
    expect(r.class).toBe('external');
  });

  it('honours an explicit repo annotation', async () => {
    const r = await classifyAction(
      { selector: '#x', text: 'Apply', dataAttributes: { bugpatrolSafe: 'true' } },
      { origin: 'http://localhost:3000' },
    );
    expect(r.class).toBe('safe-action');
  });

  it('honours the annotation names from before the rename', async () => {
    const safe = await classifyAction(
      { selector: '#x', text: 'Delete', dataAttributes: { bughuntersSafe: 'true' } },
      { origin: 'http://localhost:3000' },
    );
    const destructive = await classifyAction(
      { selector: '#x', text: 'Apply', dataAttributes: { bughuntersDestructive: 'true' } },
      { origin: 'http://localhost:3000' },
    );
    expect([safe.class, destructive.class]).toEqual(['safe-action', 'destructive']);
  });
});
