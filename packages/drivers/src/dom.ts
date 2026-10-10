import type { RoutineStep, Locator as StableLocator } from '@bugpatrol/core';
import type { Locator, Page } from 'playwright';
import type { DriverAction, Observation, UiElement } from './types.js';

/** Keep refs tied to one observation while recording selectors that can be replayed. */
export async function observeDom(page: Page): Promise<UiElement[]> {
  return page.evaluate(() => {
    const candidates = [
      'a',
      'button',
      'input',
      'textarea',
      'select',
      '[role]',
      '[onclick]',
      '[tabindex]:not([tabindex="-1"])',
      '[contenteditable]',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'label',
      'summary',
      '[aria-expanded]',
    ].join(',');
    const result: UiElement[] = [];

    const unique = (selector: string) => {
      try {
        return document.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    };

    const selectorFor = (element: Element) => {
      if (element.id && unique(`#${CSS.escape(element.id)}`)) {
        return `#${CSS.escape(element.id)}`;
      }
      const testId = element.getAttribute('data-testid');
      if (testId) {
        const selector = `[data-testid="${CSS.escape(testId)}"]`;
        if (unique(selector)) {
          return selector;
        }
      }
      const parts: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const current = node;
        const parent = current.parentElement;
        const siblings = parent ? Array.from(parent.children).filter((child) => child.tagName === current.tagName) : [];
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${current.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${index})` : ''}`);
        const selector = parts.join(' > ');
        if (unique(selector)) {
          return selector;
        }
      }
      return parts.join(' > ');
    };

    const trim = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '';
    const implicitRole = (tag: string, type: string | undefined): string => {
      const roles: Record<string, string> = {
        a: 'link',
        button: 'button',
        select: 'combobox',
        textarea: 'textbox',
        label: 'label',
      };
      const inputRoles: Record<string, string> = {
        checkbox: 'checkbox',
        radio: 'radio',
        button: 'button',
        submit: 'button',
        reset: 'button',
        search: 'searchbox',
        file: 'button',
        number: 'spinbutton',
        range: 'slider',
      };
      if (tag === 'input') {
        return inputRoles[type ?? ''] ?? 'textbox';
      }
      if (/^h[1-6]$/.test(tag)) {
        return 'heading';
      }
      return roles[tag] ?? 'button';
    };

    for (const element of Array.from(document.querySelectorAll(candidates))) {
      if (result.length >= 150) {
        break;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const tabIndex = element.getAttribute('tabindex');
      const known = element.matches(
        'a,button,input,textarea,select,[role],[onclick],h1,h2,h3,h4,h5,h6,label,summary,[aria-expanded]',
      );
      const validTabIndex = tabIndex === null || Number(tabIndex) >= 0;
      const validEditable = element.getAttribute('contenteditable') !== 'false';
      if (!validTabIndex && !known && !element.matches('[contenteditable]')) {
        continue;
      }
      if (!validEditable && !known && tabIndex === null) {
        continue;
      }
      const hasArea = rect.width > 0 && rect.height > 0;
      const inViewport = rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      if (!hasArea || !inViewport) {
        continue;
      }
      const displayed = style.display !== 'none' && style.visibility !== 'hidden';
      const visible = Number(style.opacity) > 0.01;
      const checkedVisibility = element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      if (!displayed || !visible || !checkedVisibility) {
        continue;
      }
      const html = element as HTMLElement;
      const input = element as HTMLInputElement;
      const tag = element.tagName.toLowerCase();
      if (tag === 'label') {
        // The control is listed in its place, unless the label stands in for
        // a hidden one, as a styled label does for a file input.
        const forId = element.getAttribute('for');
        const control = (forId && document.getElementById(forId)) || element.querySelector('input,select,textarea');
        if (control?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
          continue;
        }
      }
      const type = input.type?.toLowerCase();
      const forControl = tag === 'label' && element.matches('label[for], label:has(input,select,textarea)');
      const interactive = !/^h[1-6]$/.test(tag) && (tag !== 'label' || forControl);
      const role = element.getAttribute('role') || implicitRole(tag, type);
      const labelledBy = element
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      const isControl =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement;
      const associated = isControl
        ? Array.from(element.labels ?? [])
            .map((label) => label.textContent ?? '')
            .join(' ')
        : '';
      const text = trim(html.innerText || element.textContent);
      const name = trim(
        element.getAttribute('aria-label') ||
          labelledBy ||
          associated ||
          element.getAttribute('placeholder') ||
          element.getAttribute('alt') ||
          element.getAttribute('title') ||
          text,
      );
      if (!interactive && !text) {
        continue;
      }
      const value =
        tag === 'input' || tag === 'textarea' || tag === 'select'
          ? type === 'password'
            ? '••••'
            : input.value
          : undefined;
      result.push({
        ref: `e${result.length + 1}`,
        role,
        name,
        text,
        value,
        testId: element.getAttribute('data-testid') || undefined,
        selector: selectorFor(element),
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        interactive,
        enabled: !input.disabled && element.getAttribute('aria-disabled') !== 'true',
        focused: document.activeElement === element,
        checked:
          type === 'checkbox' || type === 'radio' ? input.checked : element.getAttribute('aria-checked') === 'true',
        expanded:
          tag === 'summary'
            ? Boolean(element.parentElement instanceof HTMLDetailsElement && element.parentElement.open)
            : element.hasAttribute('aria-expanded')
              ? element.getAttribute('aria-expanded') === 'true'
              : undefined,
      });
    }
    return result;
  });
}

export type ResolvedTarget = {
  locator?: Locator;
  point?: { x: number; y: number };
  degraded: boolean;
  element?: UiElement;
};

/** Prefer replayable locators; a stored point remains the last resort. */
export async function resolveTarget(
  page: Page,
  target: string | StableLocator,
  lastObservation?: Observation,
): Promise<ResolvedTarget> {
  if (typeof target === 'string') {
    const element = lastObservation?.elements.find((item) => item.ref === target);
    if (!element?.selector) {
      throw new Error(`Unknown element ref: ${target}`);
    }
    return { locator: page.locator(element.selector), degraded: false, element };
  }
  const choices: Locator[] = [];
  if (target.testId) {
    const escaped = target.testId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    choices.push(page.locator(`[data-testid="${escaped}"]`));
  }
  if (target.role && target.name) {
    choices.push(
      page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
        name: target.name,
        exact: true,
      }),
    );
  }
  if (target.text) {
    choices.push(page.getByText(target.text, { exact: true }));
  }
  if (target.selector) {
    choices.push(page.locator(target.selector));
  }
  for (const locator of choices) {
    if (await locator.count().catch(() => 0)) {
      return { locator: locator.first(), degraded: false };
    }
  }
  if (target.point) {
    return { point: target.point, degraded: true };
  }
  throw new Error('Target not found');
}

/** Store a stable replay handle before the observation ref expires. */
export function locatorFor(element: UiElement): StableLocator {
  return {
    testId: element.testId,
    role: element.role,
    name: element.name,
    text: element.text,
    selector: element.selector,
    point: {
      x: element.box.x + element.box.width / 2,
      y: element.box.y + element.box.height / 2,
    },
  };
}

/** Record a platform-independent step after a driver action succeeds. */
export function stepFor(action: DriverAction, element?: UiElement, fallback?: StableLocator): RoutineStep {
  const target = element ? locatorFor(element) : fallback;
  switch (action.kind) {
    case 'tap':
      if (!target) {
        throw new Error('Tap needs a target');
      }
      return { kind: 'tap', target };
    case 'type':
      return {
        kind: 'type',
        target,
        value: action.value,
        submit: action.submit,
        ...(action.append ? { append: true } : {}),
      };
    case 'scroll':
      return { kind: 'scroll', direction: action.direction, target };
    case 'press':
      return { kind: 'press', key: action.key };
    case 'back':
      return { kind: 'back' };
    case 'open':
      return { kind: 'open', url: action.url };
    case 'wait':
      return { kind: 'wait', ms: action.ms };
    case 'window':
      return { kind: 'window', match: action.match };
    case 'upload':
      if (!target) {
        throw new Error('Upload needs a target');
      }
      return { kind: 'upload', target, file: action.file };
    case 'request':
    case 'run':
      return action;
  }
}
