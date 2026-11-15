import type { Ticket, TicketState } from './api.ts';

const COLUMNS: { title: string; states: TicketState[] }[] = [
  { title: 'Spec', states: ['new', 'specifying', 'specified'] },
  { title: 'Ready', states: ['ready'] },
  { title: 'In progress', states: ['preparing', 'building', 'verifying', 'reviewing'] },
  { title: 'Needs you', states: ['awaiting_approval', 'blocked'] },
  { title: 'Integrating / Done', states: ['integrating', 'done'] },
];

export function Board({ tickets }: { tickets: Ticket[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
      {COLUMNS.map((c) => (
        <section key={c.title} aria-label={c.title} className="rounded bg-gray-100 p-2">
          <h2 className="mb-2 font-semibold">{c.title}</h2>
          <ul className="space-y-2">
            {tickets.filter((t) => c.states.includes(t.state)).map((t) => (
              <li key={t.id}>
                <a href={`#/${t.id}`} className="block rounded border bg-white p-2 hover:border-blue-500">
                  <span className="font-mono text-sm text-gray-600">{t.id}</span> <span className="text-xs uppercase text-gray-500">{t.state}</span>
                  <div>{t.title}</div>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
