'use client';

import { useState } from 'react';

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="inline-flex items-center gap-4 rounded-xl border border-rule bg-raised py-2 pr-2 pl-5 font-mono text-[15px] shadow-lg shadow-slate-900/5 backdrop-blur">
      <span>
        <span className="text-muted select-none">$ </span>
        {command}
      </span>
      <button
        type="button"
        onClick={copy}
        className="rounded-lg border border-rule px-3 py-1 font-sans text-muted text-sm transition hover:border-lime/50 hover:text-ink"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
