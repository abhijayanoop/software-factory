import type { TicketState } from './types.ts';
export type { TicketState };

// blocked exits to any non-terminal state here; tickets.transition narrows it (blocked_from, ready, cancelled).
const NON_TERMINAL_EXCEPT_BLOCKED: TicketState[] = ['new', 'specifying', 'specified', 'ready', 'preparing',
  'building', 'verifying', 'reviewing', 'awaiting_approval', 'integrating'];

export const TRANSITIONS: Record<TicketState, TicketState[]> = {
  new: ['specifying', 'specified', 'cancelled'],
  specifying: ['specified', 'blocked', 'cancelled'],
  specified: ['ready', 'cancelled'],
  ready: ['preparing', 'cancelled'],
  preparing: ['building', 'blocked', 'cancelled'],
  building: ['verifying', 'blocked', 'cancelled'],
  verifying: ['reviewing', 'building', 'blocked', 'cancelled'],
  reviewing: ['awaiting_approval', 'building', 'blocked', 'cancelled'],
  awaiting_approval: ['integrating', 'ready', 'cancelled'],
  integrating: ['done', 'blocked', 'cancelled'],
  blocked: [...NON_TERMINAL_EXCEPT_BLOCKED, 'cancelled'],
  done: [],
  cancelled: [],
};

export const HUMAN = new Set<string>([
  'new>specified', 'specified>ready', 'awaiting_approval>integrating', 'awaiting_approval>ready',
  ...TRANSITIONS.blocked.map((t) => `blocked>${t}`),
  ...Object.keys(TRANSITIONS).filter((s) => TRANSITIONS[s as TicketState].includes('cancelled')).map((s) => `${s}>cancelled`),
]);

export const ACTIVE: TicketState[] = ['specifying', 'ready', 'preparing', 'building', 'verifying', 'reviewing', 'integrating'];

export const canTransition = (from: TicketState, to: TicketState): boolean => TRANSITIONS[from].includes(to);
export const isHumanTransition = (from: TicketState, to: TicketState): boolean => HUMAN.has(`${from}>${to}`);
