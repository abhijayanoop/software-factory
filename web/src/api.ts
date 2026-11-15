import type { Finding, Run, Ticket, Event } from '../../src/types.ts';

export type { Finding, Run, Ticket, Event };
export type { TicketState } from '../../src/types.ts';
export interface Detail { ticket: Ticket; runs: Run[]; events: Event[]; diff?: string }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

export const getTickets = () => req<Ticket[]>('/api/tickets');
export const getDetail = (id: string) => req<Detail>(`/api/tickets/${id}`);
export const getLog = (runId: number, offset: number) => req<{ text: string; offset: number }>(`/api/runs/${runId}/log?offset=${offset}`);
export const act = (id: string, action: string, body: object = {}) =>
  req<{ ticket: Ticket }>(`/api/tickets/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
