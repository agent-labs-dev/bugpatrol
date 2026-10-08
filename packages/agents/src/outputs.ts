import type { ClaimComparison, ClaimOutput, RoutineStep } from '@bugpatrol/core';
import type { Observation } from '@bugpatrol/drivers';

/**
 * What normalising does to an output before the diff, in order. Each rule
 * drops a value that differs on every run, so only a change in behavior is
 * left. The review lists them.
 */
const RULES: { words: string; apply: (text: string) => string }[] = [
  { words: 'JSON bodies get their keys sorted', apply: sortJson },
  {
    words: 'ISO 8601 times become <time>',
    apply: (text) =>
      text.replaceAll(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>'),
  },
  {
    words: 'HTTP dates become <time>',
    apply: (text) =>
      text.replaceAll(
        /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT\b/g,
        '<time>',
      ),
  },
  {
    words: 'UUIDs become <uuid>',
    apply: (text) => text.replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'),
  },
  {
    words: 'hex ids of 24 or more digits become <hex>',
    apply: (text) => text.replaceAll(/\b[0-9a-f]{24,}\b/gi, '<hex>'),
  },
  {
    words: 'Unix times in seconds or milliseconds (10 or 13 digits) become <epoch>',
    apply: (text) => text.replaceAll(/\b1\d{9}(?:\d{3})?\b/g, '<epoch>'),
  },
  {
    words: 'durations such as 12ms or 1.5s become <duration>',
    apply: (text) => text.replaceAll(/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms)\b|\b\d+\.\d+s\b/g, '<duration>'),
  },
  { words: 'spaces at the end of a line are dropped', apply: (text) => text.replaceAll(/[ \t\r]+$/gm, '') },
];

/** A JSON text with its object keys sorted, so a change of key order is not a change of behavior. */
function sortJson(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sorted((item as Record<string, unknown>)[key])]),
          )
        : item;
  return JSON.stringify(sorted(value), null, 2);
}

const normalise = (text: string) => RULES.reduce((out, rule) => rule.apply(out), text);

/**
 * The normalised output of a step that runs a command or sends a request,
 * read from the screen after it: the exit code and the output, or the
 * status, the content type and the body. Other steps have no output.
 */
export function outputOf(step: RoutineStep, screen: Observation): ClaimOutput | undefined {
  if (step.kind === 'run' && screen.terminal)
    return {
      step: `$ ${step.command}`,
      text: `exit ${screen.terminal.exitCode ?? 'none'}\n${normalise(screen.terminal.output)}`,
    };
  if (step.kind === 'request' && screen.http)
    return {
      step: `${step.method} ${step.url}`,
      text: `${screen.http.status} ${screen.http.contentType ?? '(no content type)'}\n${normalise(screen.http.body)}`,
    };
  return undefined;
}

/** At most this many changed lines show for one output. */
const MAX_LINES = 40;

/**
 * The changed lines of two texts: the lines of the base after `- `, the
 * lines of the pull request after `+ `. Lines that both share stay out.
 */
function lineDiff(base: string, head: string): string {
  let a = base.split('\n');
  let b = head.split('\n');
  while (a.length && b.length && a[0] === b[0]) [a, b] = [a.slice(1), b.slice(1)];
  while (a.length && b.length && a.at(-1) === b.at(-1)) [a, b] = [a.slice(0, -1), b.slice(0, -1)];
  const lines: string[] = [];
  if (a.length * b.length > 1_000_000) lines.push(...a.map((line) => `- ${line}`), ...b.map((line) => `+ ${line}`));
  else {
    // The longest common run of lines, so a line that moved shows as one removal and one addition.
    const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        i++;
        j++;
      } else if (j >= b.length || (i < a.length && common[i + 1]![j]! >= common[i]![j + 1]!)) lines.push(`- ${a[i++]}`);
      else lines.push(`+ ${b[j++]}`);
    }
  }
  if (lines.length <= MAX_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more changed lines`].join('\n');
}

/** The outputs of the two builds side by side: the rules, and each output that differs. */
export function compareOutputs(base: ClaimOutput[], head: ClaimOutput[]): ClaimComparison {
  const parts = head.flatMap((output, index) => {
    const other = base[index]?.text ?? '';
    return output.text === other ? [] : [{ step: output.step, diff: lineDiff(other, output.text) }];
  });
  return { rules: RULES.map((rule) => rule.words), parts };
}
