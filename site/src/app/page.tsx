import Image from 'next/image';
import type { ReactNode } from 'react';
import { CopyCommand } from '@/components/CopyCommand';
import { SetupTabs } from '@/components/SetupTabs';

const repo = 'https://github.com/agent-labs-dev/bugpatrol';
const docs = `${repo}/blob/main/docs`;
const asset = (file: string) => `${process.env.NEXT_PUBLIC_BASE_PATH}/assets/${file}`;

const agents = [
  {
    name: 'Explorer',
    body: 'Runs your app, maps its screens, and reports what looks wrong. It sees each screen, the console errors, and the failed requests.',
  },
  {
    name: 'Judge',
    body: 'Decides which reports are real bugs, writes the issues, and checks each fix. Give it your strongest model.',
  },
  {
    name: 'Fixer',
    body: 'Writes a fix in its own git worktree, with the agent CLI you already use: Claude Code, Codex, Kimi CLI, or pi.',
  },
];

const steps = [
  { name: 'Explore', body: 'The explorer uses the app and files bug reports.' },
  { name: 'Judge', body: 'The judge keeps the real bugs and writes the issues.' },
  { name: 'Fix', body: 'The fixer writes a fix for the worst issues.' },
  { name: 'Retest', body: 'The explorer and the judge check each fix in the running app.' },
  { name: 'Publish', body: 'A PR for each fix, and an issue for each major bug with no fix.' },
];

const patrolFacts = [
  'Every 30 minutes, the patrol pulls the latest main. It explores and judges only when main has new commits, so a patrol that runs all day costs little when nobody merges.',
  'On the same commit it still finishes the open work: fixes, retests, publish, CI checks, and the GitHub sync. A fix never waits for the next merge.',
  'Close any issue or PR it opened, and the patrol learns from it. It does not open it again.',
  'The fixer and GitHub stay off until you turn them on. PRs are drafts by default.',
];

const support = [
  {
    label: 'Platforms',
    value: 'Web (Playwright), Electron (CDP), iOS and Android (Maestro), desktop (Cua), HTTP APIs and CLIs',
  },
  { label: 'Login', value: 'Any auth system: your own setup commands plus plain-English instructions' },
  {
    label: 'Agent LLMs',
    value:
      'Claude Code, Codex, Kimi CLI, pi, or any CLI agent. Or an API key for OpenRouter, Vercel AI Gateway, OpenAI, Anthropic, or a custom endpoint',
  },
  { label: 'GitHub', value: 'PRs, issues, and state sync through the gh CLI' },
  { label: 'Output', value: 'A local dashboard, GitHub PRs and issues, and JSON files under .bugpatrol/runs/' },
];

function Section({
  id,
  eyebrow,
  title,
  intro,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20 sm:py-28">
      <p className="font-mono text-lime-deep text-sm uppercase tracking-widest">{eyebrow}</p>
      <h2 className="mt-3 max-w-3xl font-semibold text-3xl tracking-tight sm:text-4xl">{title}</h2>
      <p className="mt-4 max-w-2xl text-lg text-muted">{intro}</p>
      <div className="mt-12">{children}</div>
    </section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-rule bg-sunk px-5 py-4 font-mono text-[14px] leading-7">
      {children}
    </pre>
  );
}

function Prompt() {
  return <span className="select-none text-muted">$ </span>;
}

function Comment({ children }: { children: ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

const withAgent = (
  <div className="space-y-6">
    <div>
      <h3 className="font-semibold">1. Install the Bugpatrol skill in your repo</h3>
      <p className="mt-1 mb-3 text-muted">
        It works with Claude Code, Codex, Cursor, and many other agents. Commit the skill and{' '}
        <code className="font-mono text-ink text-sm">skills-lock.json</code>, so your team gets it too.
      </p>
      <Code>
        <Prompt />
        npx skills add agent-labs-dev/bugpatrol
      </Code>
    </div>
    <div>
      <h3 className="font-semibold">2. Ask your agent</h3>
      <p className="mt-1 mb-3 text-muted">
        The skill tells the agent how to configure Bugpatrol for your app, how to run it, and how to show you the
        results.
      </p>
      <Code>Set up Bugpatrol for this repo.</Code>
    </div>
  </div>
);

const byHand = (
  <div className="space-y-6">
    <p className="text-muted">
      You need Node 22 or later, <code className="font-mono text-ink text-sm">git</code>, a command that launches your
      app, and a way to sign in. To open PRs and issues, a logged-in{' '}
      <code className="font-mono text-ink text-sm">gh</code> CLI.
    </p>
    <Code>
      <Comment># find your app and the LLMs on your machine, and write .bugpatrol/</Comment>
      {'\n'}
      <Prompt />
      npx bugpatrol init{'\n\n'}
      <Comment># check .bugpatrol/bugpatrol.yml, write .bugpatrol/instructions.md, then patrol</Comment>
      {'\n'}
      <Prompt />
      npx bugpatrol{'\n\n'}
      <Comment># watch it work at http://127.0.0.1:4311</Comment>
      {'\n'}
      <Prompt />
      npx bugpatrol dashboard
    </Code>
    <p className="text-muted">
      For a web app, install Chromium for Playwright once. Each step also runs on its own:{' '}
      <code className="font-mono text-ink text-sm">explore</code>,{' '}
      <code className="font-mono text-ink text-sm">judge</code>, <code className="font-mono text-ink text-sm">fix</code>
      , <code className="font-mono text-ink text-sm">publish</code>.
    </p>
  </div>
);

export default function Home() {
  return (
    <>
      <header className="sticky top-0 z-10 border-rule/60 border-b bg-sunk backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="#top" className="flex items-center gap-2.5 font-semibold">
            <Image src={asset('logo.svg')} alt="" width={30} height={30} />
            Bugpatrol
          </a>
          <nav className="flex items-center gap-6 text-muted text-sm">
            <a href="#how" className="hidden hover:text-ink sm:block">
              How it works
            </a>
            <a href="#start" className="hidden hover:text-ink sm:block">
              Get started
            </a>
            <a href={`${repo}/tree/main/docs`} className="hidden hover:text-ink sm:block">
              Docs
            </a>
            <a
              href={repo}
              className="rounded-lg border border-rule px-3 py-1.5 text-ink transition hover:border-lime/50"
            >
              GitHub
            </a>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="relative overflow-hidden">
          <div className="grid-backdrop absolute inset-0 -z-10" />
          <div className="mx-auto max-w-4xl px-6 pt-24 pb-16 text-center sm:pt-32">
            <p className="inline-flex items-center gap-2 rounded-full border border-rule bg-raised/60 px-3 py-1 font-mono text-muted text-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-lime" />
              Open source · Apache-2.0
            </p>
            <h1 className="mt-6 font-semibold text-5xl tracking-tight sm:text-7xl">
              A QA team made of <span className="text-lime-deep">agents</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-muted sm:text-xl">
              Bugpatrol uses your app the way a tester does. It finds bugs, fixes them, checks each fix in the running
              app, and opens the pull requests and issues for your team.
            </p>
            <div className="mt-10">
              <CopyCommand command="npx bugpatrol" />
            </div>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <a
                href="#start"
                className="rounded-xl bg-lime px-5 py-2.5 font-semibold text-ink transition hover:bg-lime-soft"
              >
                Get started
              </a>
              <a
                href={repo}
                className="rounded-xl border border-rule px-5 py-2.5 font-semibold transition hover:border-lime/50"
              >
                View on GitHub
              </a>
            </div>
            <p className="mt-8 font-mono text-muted text-xs tracking-wider">
              WEB · ELECTRON · iOS · ANDROID · DESKTOP · API · CLI
            </p>
          </div>
          <div className="mx-auto max-w-6xl px-6">
            <Image
              src={asset('dashboard.png')}
              width={1814}
              height={1351}
              priority
              alt="The Bugpatrol dashboard: the agent cards, the issues that need attention, the live screen, the coverage, and the token usage."
              className="w-full rounded-2xl border border-rule shadow-2xl shadow-slate-900/15"
            />
          </div>
        </section>

        <Section
          id="what"
          eyebrow="What it is"
          title="Three agents that test like your QA team"
          intro="Bugpatrol runs on your machine and works on web, desktop, and mobile apps. The Nebula team uses it every day to test our own apps, and we made it open source so that all teams can use it."
        >
          <div className="grid gap-4 md:grid-cols-3">
            {agents.map((agent) => (
              <div key={agent.name} className="rounded-2xl border border-rule bg-raised p-6">
                <p className="font-mono text-sm text-violet">LLM agent</p>
                <h3 className="mt-2 font-semibold text-xl">{agent.name}</h3>
                <p className="mt-3 text-muted">{agent.body}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="how"
          eyebrow="How it works"
          title="One patrol, again and again"
          intro={
            <>
              <code className="font-mono text-base text-ink">npx bugpatrol</code> pulls main, starts your app, and runs
              the full cycle. Then it waits for a new commit and runs it again.
            </>
          }
        >
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {steps.map((step, index) => (
              <li key={step.name} className="relative rounded-2xl border border-rule bg-raised p-5">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-lime/15 font-bold font-mono text-lime-deep">
                  {index + 1}
                </span>
                <h3 className="mt-4 font-semibold">{step.name}</h3>
                <p className="mt-1 text-muted text-sm">{step.body}</p>
              </li>
            ))}
          </ol>
          <ul className="mt-10 grid gap-x-10 gap-y-4 md:grid-cols-2">
            {patrolFacts.map((fact) => (
              <li key={fact} className="flex gap-3 text-muted">
                <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-lime" />
                {fact}
              </li>
            ))}
          </ul>
          <p className="mt-8">
            <a href={`${docs}/how-it-works.md`} className="text-lime-deep hover:underline">
              Read how it works →
            </a>
          </p>
        </Section>

        <Section
          id="start"
          eyebrow="Get started"
          title="Set it up in two minutes"
          intro="Let your coding agent set it up, or run init yourself. Bugpatrol needs two things from you: a command that launches your app, and a way to sign in."
        >
          <SetupTabs
            tabs={[
              { label: 'With your agent', body: withAgent },
              { label: 'By hand', body: byHand },
            ]}
          />
          <p className="mt-6">
            <a href={`${docs}/getting-started.md`} className="text-lime-deep hover:underline">
              Full getting started guide, with Electron and mobile examples →
            </a>
          </p>
        </Section>

        <Section
          id="support"
          eyebrow="What is supported"
          title="Works with your app and your models"
          intro="Each agent can use a different LLM. Give the judge your strongest model, and the explorer a fast, low-cost one."
        >
          <dl className="divide-y divide-rule overflow-hidden rounded-2xl border border-rule bg-raised">
            {support.map((row) => (
              <div key={row.label} className="grid gap-1 px-6 py-5 sm:grid-cols-[180px_1fr] sm:gap-6">
                <dt className="font-semibold">{row.label}</dt>
                <dd className="text-muted">{row.value}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="relative overflow-hidden rounded-3xl border border-rule bg-raised px-8 py-16 text-center">
            <div className="grid-backdrop absolute inset-0" />
            <div className="relative">
              <Image src={asset('logo.svg')} alt="" width={64} height={64} className="mx-auto" />
              <h2 className="mt-6 font-semibold text-3xl tracking-tight sm:text-4xl">Put your app on patrol</h2>
              <p className="mx-auto mt-4 max-w-xl text-muted">
                Bugpatrol is free and open source under Apache-2.0. Star it, read the code, and open an issue.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <a
                  href={repo}
                  className="rounded-xl bg-lime px-5 py-2.5 font-semibold text-ink transition hover:bg-lime-soft"
                >
                  Star on GitHub
                </a>
                <a
                  href="https://www.npmjs.com/package/bugpatrol"
                  className="rounded-xl border border-rule px-5 py-2.5 font-semibold transition hover:border-lime/50"
                >
                  npm package
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-rule border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-8 text-muted text-sm sm:flex-row sm:justify-between">
          <p>
            Made by the{' '}
            <a href="https://nebula.gg" className="text-ink hover:underline">
              Nebula
            </a>{' '}
            team.
          </p>
          <p className="flex gap-5">
            <a href={repo} className="hover:text-ink">
              GitHub
            </a>
            <a href={`${repo}/tree/main/docs`} className="hover:text-ink">
              Docs
            </a>
            <a href={`${repo}/blob/main/LICENSE`} className="hover:text-ink">
              License
            </a>
          </p>
        </div>
      </footer>
    </>
  );
}
