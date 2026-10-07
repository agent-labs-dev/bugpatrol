'use client';

import { type ReactNode, useState } from 'react';

type Tab = { label: string; body: ReactNode };

export function SetupTabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(0);

  return (
    <div className="overflow-hidden rounded-2xl border border-rule bg-raised">
      <div className="flex gap-1 border-rule border-b p-2" role="tablist">
        {tabs.map((tab, index) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            aria-selected={index === active}
            onClick={() => setActive(index)}
            className={`rounded-lg px-4 py-2 font-medium text-sm transition ${
              index === active ? 'bg-lime/15 text-lime-deep' : 'text-muted hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="p-6 sm:p-8" role="tabpanel">
        {tabs[active]?.body}
      </div>
    </div>
  );
}
