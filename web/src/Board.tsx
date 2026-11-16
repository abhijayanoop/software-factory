import type { Ticket, TicketState } from './api.ts';

// One color per lifecycle phase: dot + text class.
const PHASE = {
  spec: ['bg-sky-400', 'text-sky-300'],
  ready: ['bg-indigo-400', 'text-indigo-300'],
  work: ['bg-amber-400 animate-pulse', 'text-amber-300'],
  you: ['bg-violet-400', 'text-violet-300'],
  blocked: ['bg-rose-400', 'text-rose-300'],
  done: ['bg-emerald-400', 'text-emerald-300'],
  off: ['bg-zinc-600', 'text-zinc-500'],
} as const;
const PHASE_OF: Record<TicketState, keyof typeof PHASE> = {
  new: 'spec', specifying: 'spec', specified: 'spec', ready: 'ready',
  preparing: 'work', building: 'work', verifying: 'work', reviewing: 'work', integrating: 'work',
  awaiting_approval: 'you', blocked: 'blocked', done: 'done', cancelled: 'off',
};

export function StatePill({ state }: { state: TicketState }) {
  const [dot, text] = PHASE[PHASE_OF[state]];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${text}`}>
      <span className={`size-1.5 rounded-full ${dot}`} />{state.replace('_', ' ')}
    </span>
  );
}

export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const COLUMNS: { title: string; states: TicketState[]; accent?: boolean }[] = [
  { title: 'Spec', states: ['new', 'specifying', 'specified'] },
  { title: 'Ready', states: ['ready'] },
  { title: 'In progress', states: ['preparing', 'building', 'verifying', 'reviewing', 'integrating'] },
  { title: 'Needs you', states: ['awaiting_approval', 'blocked'], accent: true },
  { title: 'Done', states: ['done', 'cancelled'] },
];

export function Board({ tickets }: { tickets: Ticket[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
      {COLUMNS.map((c) => {
        const list = tickets.filter((t) => c.states.includes(t.state));
        const hot = c.accent && list.length > 0;
        return (
          <section key={c.title} aria-label={c.title}
            className={`rounded-xl border p-2 ${hot ? 'border-violet-500/30 bg-violet-500/[0.04]' : 'border-white/5 bg-white/[0.015]'}`}>
            <h2 className="flex items-center justify-between px-2 pt-1 pb-3 text-xs font-medium tracking-wide text-zinc-400 uppercase">
              {c.title}
              <span className={`rounded-md px-1.5 py-0.5 font-mono text-[11px] ${hot ? 'bg-violet-500/20 text-violet-200' : 'bg-white/5 text-zinc-500'}`}>{list.length}</span>
            </h2>
            <ul className="space-y-2">
              {list.map((t) => (
                <li key={t.id}>
                  <a href={`#/${t.id}`}
                    className={`group block rounded-lg border border-white/[0.06] bg-zinc-900/60 p-3 transition hover:border-white/15 hover:bg-zinc-900 ${t.state === 'cancelled' ? 'opacity-50' : ''}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] text-zinc-500">{t.id}</span>
                      <StatePill state={t.state} />
                    </div>
                    <div className="mt-1.5 text-sm leading-snug text-zinc-100 group-hover:text-white">{t.title}</div>
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
                      <span className="truncate">{t.repoId}</span>·<span>{ago(t.updatedAt)}</span>
                      {t.attempt > 1 && <>·<span>attempt {t.attempt}</span></>}
                    </div>
                  </a>
                </li>
              ))}
              {list.length === 0 && <li className="px-2 pb-2 text-xs text-zinc-600">Nothing here</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
