import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { WebDriver } from './web.js';

it('uses the default answer for a keyboard-triggered dialog after a tap that opened no dialog', async () => {
  const accept = vi.fn(async () => {});
  const dismiss = vi.fn(async () => {});
  const events = new EventEmitter();
  const page = Object.assign(events, {
    url: () => 'about:blank',
    waitForLoadState: async () => {},
    mouse: { click: async () => {} },
    keyboard: {
      press: async () => {
        events.emit('dialog', {
          message: () => 'Submit this form?',
          type: () => 'confirm',
          accept,
          dismiss,
        });
      },
    },
  }) as unknown as Page;
  class Fixture extends WebDriver {
    bind() {
      this.page = page;
      this.watch(page);
    }
  }
  const driver = new Fixture({ url: '', viewport: { width: 100, height: 100 } });
  driver.bind();
  expect((await driver.act({ kind: 'tap', locator: { point: { x: 1, y: 1 } }, dialog: 'dismiss' })).ok).toBe(true);
  expect((await driver.act({ kind: 'press', key: 'Enter' })).ok).toBe(true);
  expect(accept).toHaveBeenCalledOnce();
  expect(dismiss).not.toHaveBeenCalled();
});
