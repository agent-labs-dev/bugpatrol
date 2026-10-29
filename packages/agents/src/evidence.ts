import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Evidence, formatHttpExchange, type HttpExchange } from '@bugpatrol/core';
import type { ToolContent } from './types.js';

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

/** What a model sees of the evidence of an issue or a candidate. */
export async function evidenceParts(root: string, evidence: Evidence): Promise<ToolContent[]> {
  if (evidence.kind === 'http') return [{ type: 'text', text: formatHttpExchange(evidence.exchange) }];
  return [
    ...(await captureParts(root, evidence.screenshot)),
    ...(await captureParts(root, evidence.baseline)),
    ...(await captureParts(root, evidence.diff)),
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
