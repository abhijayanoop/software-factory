import { useCallback, useEffect, useState } from 'react';
import { getTickets, type Ticket } from './api.ts';
import { Board } from './Board.tsx';
import { TicketPage } from './Ticket.tsx';

const route = () => /^#\/(T-\d+)$/.exec(location.hash)?.[1] ?? null;

export function App() {
  const [id, setId] = useState(route());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [err, setErr] = useState('');
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
    es.onmessage = () => { load(); setTick((n) => n + 1); };
    return () => es.close();
  }, [load]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b bg-white px-4 py-3">
        <a href="#/" className="text-lg font-semibold">Software Factory</a>
      </header>
      <main className="p-4">
        {err && <p role="alert" className="mb-3 rounded bg-red-100 p-2 text-red-800">{err}</p>}
        {id ? <TicketPage id={id} tick={tick} onChange={load} /> : <Board tickets={tickets} />}
      </main>
    </div>
  );
}
