export type Cast = { width: number; height: number; events: { at: number; text: string }[] };
export function parseCast(source: string): Cast | undefined;
