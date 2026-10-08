import { describe, expect, it } from 'vitest';
import {
  buildFlow,
  flattenHierarchy,
  maestroKey,
  nativeSnapshot,
  parseHierarchy,
  pruneSystemChrome,
  regexText,
  scrollCommand,
  tapCommand,
  typeCommands,
  yamlString,
} from './maestro.js';
import type { Observation, UiElement } from './types.js';

const hierarchy = {
  ui_schema: {
    abbreviations: {
      b: 'bounds',
      txt: 'text',
      rid: 'resource-id',
      a11y: 'accessibilityText',
      hint: 'hintText',
      val: 'value',
      c: 'children',
    },
    defaults: { enabled: true, focused: false, checked: false, txt: '', hint: '', rid: '', val: '', a11y: '' },
  },
  elements: [
    {
      b: '[0,0][393,852]',
      a11y: 'Acme',
      c: [
        { b: '[10,80][200,120]', a11y: 'Save (2)?', c: [{ b: '[10,80][200,120]', a11y: 'Save (2)?' }] },
        { b: '[10,130][200,180]', hint: 'Email', val: '' },
        { b: '[0,0][0,0]', txt: 'invisible' },
        { b: '[10,200][200,220]', txt: 'Welcome' },
      ],
    },
  ],
};

describe('Maestro data conversion', () => {
  it('normalises case-insensitive key names for each mobile platform', () => {
    expect(maestroKey('eNtEr', 'ios')).toBe('Enter');
    expect(maestroKey('RETURN', 'ios')).toBe('Enter');
    expect(maestroKey('BACKSPACE', 'ios')).toBe('Backspace');
    expect(maestroKey('home', 'android')).toBe('Home');
    expect(maestroKey('BACK', 'android')).toBe('back');
    expect(maestroKey('back', 'ios')).toBe('Back');
  });
  it('ignores noise, applies defaults, and flattens nested duplicate nodes', () => {
    const schema = parseHierarchy([
      { type: 'text', text: 'Important: Maestro Viewer is available at ...' },
      { type: 'text', text: JSON.stringify(hierarchy) },
    ]);
    const { elements, viewport } = flattenHierarchy(schema);
    expect(viewport).toEqual({ width: 393, height: 852 });
    expect(elements.map((element) => element.ref)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(elements.filter((element) => element.name === 'Save (2)?')).toHaveLength(1);
    expect(elements.find((element) => element.name === 'Email')).toMatchObject({
      role: 'textbox',
      enabled: true,
      focused: false,
    });
    expect(elements.some((element) => element.name === 'invisible')).toBe(false);
  });

  it('takes the viewport from the windows when the Android root node has no bounds', () => {
    const android = {
      elements: [
        {
          children: [
            { bounds: '[0,0][1080,132]', 'resource-id': 'status_bar' },
            { bounds: '[0,0][1080,2400]', children: [{ bounds: '[40,300][1040,400]', text: 'Your classes' }] },
          ],
        },
      ],
    };
    const { elements, viewport } = flattenHierarchy(android);
    expect(viewport).toEqual({ width: 1080, height: 2400 });
    expect(elements.some((element) => element.name === 'Your classes')).toBe(true);
  });

  it('builds stable tap YAML and safely quotes input text', () => {
    expect(tapCommand({ testId: 'save:button' })).toContain('id: "save:button"');
    expect(tapCommand({ name: 'Save (2)?' })).toContain(`text: ${yamlString(regexText('Save (2)?'))}`);
    expect(regexText('Save (2)?')).toBe('^Save \\(2\\)\\?$');
    expect(tapCommand({ point: { x: 24.8, y: 100.2 } })).toContain('point: "25,100"');
    expect(yamlString('say "yes":\nnext')).toBe('"say \\"yes\\":\\nnext"');
    expect(buildFlow('com.example.app', [`inputText: ${yamlString('say "yes":\nnext')}`, 'pressKey: Enter'])).toContain(
      '- inputText: "say',
    );
  });

  it('clears native text by default and preserves it when appending', () => {
    const target = { locator: { name: 'First name' }, element: { value: 'Old' } as UiElement };
    expect(typeCommands({ kind: 'type', value: 'New' }, target)).toEqual([
      tapCommand(target.locator),
      'eraseText: 13',
      'inputText: "New"',
    ]);
    expect(typeCommands({ kind: 'type', value: 'More', append: true }, target)).toEqual([
      tapCommand(target.locator),
      'inputText: "More"',
    ]);
    expect(typeCommands({ kind: 'type', value: 'New' }, {})).toContain('eraseText: 100');
  });

  it('maps scroll direction to the opposite swipe', () => {
    expect(scrollCommand('down')).toContain('UP');
    expect(scrollCommand('up')).toContain('DOWN');
    expect(scrollCommand('left')).toContain('RIGHT');
    expect(scrollCommand('right')).toContain('LEFT');
  });

  it('converts native elements to geometry without false occlusion', () => {
    const { elements } = flattenHierarchy(hierarchy);
    const observation = {
      platform: 'ios',
      location: 'com.example.app',
      screenshot: Buffer.alloc(0),
      volatileRegions: [],
      at: new Date().toISOString(),
      title: 'Acme',
      viewport: { width: 393, height: 852, scale: 3 },
      elements,
      consoleErrors: [],
    } satisfies Observation;
    const snapshot = nativeSnapshot(observation, 'home');
    expect(snapshot.document).toMatchObject({ scrollWidth: 393, clientHeight: 852, hasStylesheets: true });
    expect(snapshot.elements[0]).toMatchObject({ visible: true, rendered: true, zIndex: 0 });
    expect(snapshot.elements[0]?.hitSelector).toBe(snapshot.elements[0]?.selector);
  });

  it('drops OS chrome and folds an open keyboard into one element', () => {
    const element = (name: string, y: number, width = 40): UiElement => ({
      ref: 'x',
      role: 'button',
      name,
      box: { x: 0, y, width, height: 40 },
      interactive: true,
      enabled: true,
    });
    const letters = 'qwertyuiopasdfghjkl'.split('').map((key) => element(key, 600));
    const pruned = pruneSystemChrome(
      [
        { ...element('Acme (Dev)', 0, 393), box: { x: 0, y: 0, width: 393, height: 852 }, role: 'group' },
        element('11:45 PM', 10),
        element('Vertical scroll bar, 2 pages', 100),
        element('Continue', 400, 300),
        ...letters,
        element('space', 700),
      ],
      { width: 393, height: 852 },
      54,
    );
    expect(pruned.map((item) => item.name)).toEqual(['Continue', 'Software keyboard (open)']);
    expect(pruned.map((item) => item.ref)).toEqual(['e1', 'e2']);
  });

  it('keeps single-letter buttons when no keyboard is open', () => {
    const tabs = ['A', 'B'].map(
      (name, index): UiElement => ({
        ref: 'x',
        role: 'button',
        name,
        box: { x: index * 50, y: 800, width: 40, height: 40 },
        interactive: true,
        enabled: true,
      }),
    );
    expect(pruneSystemChrome(tabs, { width: 393, height: 852 }, 54)).toHaveLength(2);
  });
});
