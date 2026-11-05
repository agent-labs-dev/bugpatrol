import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Evidence, formatHttpExchange, type HttpExchange } from '@bugpatrol/core';
import type { Observation } from '@bugpatrol/drivers';
import type { ToolContent } from './types.js';

/** The most of a terminal's text that a model reads: its head and its tail. */
const TERMINAL_CHARS = 60_000;

/** A capture file of an API: the exchange as JSON (see `Workspace.saveCapture`). */
export const isExchangeFile = (file: string) => file.endsWith('.exchange.json');

/**
 * What a model sees of one capture file: a PNG as an image, an API exchange
 * as its text. No file gives nothing. A file that is gone throws: a record
 * that names it is wrong, and the model must not judge without it.
 */
export async function captureParts(root: string, file: string | undefined): Promise<ToolContent[]> {
  if (!file) return [];
  const data = await readFile(resolve(root, file));
  if (!isExchangeFile(file)) return [{ type: 'image', png: data }];
  return [{ type: 'text', text: formatHttpExchange(JSON.parse(data.toString('utf8')) as HttpExchange) }];
}

/**
 * The text of a terminal that goes beside its screenshot: the command, all
 * that it printed (or the screen of a session), and the colours of each cell
 * of the screenshot.
 */
export function terminalRecord(terminal: NonNullable<Observation['terminal']>): string {
  return [
    terminal.screen ? `Session: ${terminal.command}` : `$ ${terminal.command}`,
    terminal.exitCode === undefined
      ? terminal.screen
        ? 'The program is running.'
        : 'The command did not exit.'
      : `Exit code: ${terminal.exitCode}`,
    terminal.screen ? 'Screen:' : 'Output, complete (the screenshot shows only its last screenful):',
    terminal.output || '(none)',
    '',
    'Cells of the screenshot: each row, then runs of cells with one style, as 1-based columns, colours and text:',
    terminal.cells || '(blank)',
  ].join('\n');
}

/** What a model sees of a terminal's text: a long one keeps its head and its tail. */
async function terminalParts(root: string, file: string | undefined): Promise<ToolContent[]> {
  if (!file) return [];
  const text = await readFile(resolve(root, file), 'utf8');
  if (text.length <= TERMINAL_CHARS) return [{ type: 'text', text }];
  const half = TERMINAL_CHARS / 2;
  const left = text.length - TERMINAL_CHARS;
  return [{ type: 'text', text: `${text.slice(0, half)}\n[${left} characters left out]\n${text.slice(-half)}` }];
}

/** What a model sees of the evidence of an issue or a candidate. */
export async function evidenceParts(root: string, evidence: Evidence): Promise<ToolContent[]> {
  if (evidence.kind === 'http') return [{ type: 'text', text: formatHttpExchange(evidence.exchange) }];
  return [
    ...(await captureParts(root, evidence.screenshot)),
    ...(await captureParts(root, evidence.baseline)),
    ...(await captureParts(root, evidence.diff)),
    ...(await terminalParts(root, evidence.terminal)),
  ];
}

/** The screenshot of image evidence. An API exchange has none. */
export const screenshotOf = (evidence: Evidence): string | undefined =>
  evidence.kind === 'image' ? evidence.screenshot : undefined;

/** The exchanges of the API capture files among `files`, by file. */
export async function readExchanges(root: string, files: string[]): Promise<Map<string, HttpExchange>> {
  const exchanges = new Map<string, HttpExchange>();
  for (const file of new Set(files.filter(isExchangeFile)))
    exchanges.set(file, JSON.parse(await readFile(resolve(root, file), 'utf8')) as HttpExchange);
  return exchanges;
}
