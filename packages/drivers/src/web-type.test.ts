import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { WebDriver } from './web.js';

describe('web text actions', () => {
  it('replaces by default and appends when requested', async () => {
    let value = 'before';
    const locator = {
      fill: async (next: string) => {
        value = next;
      },
      inputValue: async () => value,
    };
    const page = {
      locator: () => locator,
      waitForLoadState: async () => undefined,
      url: () => 'about:blank',
      keyboard: { press: async () => undefined },
    } as unknown as Page;
    class Fixture extends WebDriver {
      bind() {
        this.page = page;
        this.lastObservation = {
          platform: 'web',
          location: '',
          screenshot: Buffer.alloc(0),
          viewport: { width: 100, height: 100, scale: 1 },
          volatileRegions: [],
          consoleErrors: [],
          at: '',
          elements: [
            {
              ref: 'e1',
              role: 'textbox',
              name: 'Name',
              selector: '#name',
              box: { x: 0, y: 0, width: 50, height: 20 },
              interactive: true,
              enabled: true,
            },
          ],
        };
      }
    }
    const driver = new Fixture({ url: '', viewport: { width: 100, height: 100 } });
    driver.bind();
    expect((await driver.act({ kind: 'type', ref: 'e1', value: 'new' })).ok).toBe(true);
    expect(value).toBe('new');
    expect((await driver.act({ kind: 'type', ref: 'e1', value: 'er', append: true })).step).toMatchObject({
      kind: 'type',
      append: true,
    });
    expect(value).toBe('newer');
  });
});
