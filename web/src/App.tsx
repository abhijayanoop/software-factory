import { useCallback, useEffect, useState } from 'react';
import { getTickets, type Ticket } from './api.ts';
import { Board } from './Board.tsx';
import { TicketPage } from './Ticket.tsx';

const route = () => /^#\/(T-\d+)$/.exec(location.hash)?.[1] ?? null;

export function App() {
  const [id, setId] = useState(route());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [err, setErr] = useState('');
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0); // bumps on every server event; the ticket page refetches on it

  const load = useCallback(() => getTickets().then((t) => { setTickets(t); setErr(''); }, (e) => setErr(String(e.message))), []);

  useEffect(() => {
    const onHash = () => setId(route());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    load();
    const es = new EventSource('/api/events');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = () => { load(); setTick((n) => n + 1); };
    return () => es.close();
  }, [load]);

  const waiting = tickets.filter((t) => t.state === 'awaiting_approval' || t.state === 'blocked').length;

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-200">
      <header className="sticky top-0 z-10 border-b border-white/5 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-3 sm:px-6">
          <a href="#/" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight text-zinc-100">
            <span className="grid size-6 place-items-center rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 font-mono text-[11px] text-white">sf</span>
            Software Factory
          </a>
          <div className="flex items-center gap-4 text-xs text-zinc-500">
            {waiting > 0 && <span className="rounded-full bg-violet-500/15 px-2.5 py-1 text-violet-200">{waiting} need{waiting === 1 ? 's' : ''} you</span>}
            <span className="flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-zinc-600'}`} />{live ? 'Live' : 'Offline'}
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        {err && <p role="alert" className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{err}</p>}
        {id ? <TicketPage id={id} tick={tick} onChange={load} /> : <Board tickets={tickets} />}
      </main>
    </div>
  );
}
