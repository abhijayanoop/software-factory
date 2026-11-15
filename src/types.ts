export type TicketState = 'new' | 'specifying' | 'specified' | 'ready' | 'preparing' | 'building'
  | 'verifying' | 'reviewing' | 'awaiting_approval' | 'integrating' | 'done' | 'blocked' | 'cancelled';

export interface RepoProfile {
  kind: 'ts' | 'py';
  setup: string[][];
  checks: { name: string; cmd: string[] }[];
}

export interface Repo {
  id: string;
  path: string;
  targetBranch: string;
  profileJson: string; // serialized RepoProfile
  createdAt: string;
}

export interface Ticket {
  id: string;
  repoId: string;
  title: string;
  body: string;
  spec: string | null;
  state: TicketState;
  blockedFrom: TicketState | null;
  blockedReason: string | null;
  humanNote: string | null;
  branch: string | null;
  worktreePath: string | null;
  baseSha: string | null;
  headSha: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: number;
  ticketId: string;
  kind: 'spec' | 'build' | 'verify' | 'review' | 'integrate';
  state: 'starting' | 'running' | 'succeeded' | 'failed' | 'lost' | 'cancelled';
  sandbox: string | null;
  pid: number | null;
  resultJson: string | null;
  logPath: string | null;
  startedAt: string;
  heartbeatAt: string | null;
  endedAt: string | null;
}

export interface Event {
  id: number;
  ticketId: string;
  runId: number | null;
  type: 'transition' | 'approval' | 'rejection' | 'answer' | 'note';
  fromState: string | null;
  toState: string | null;
  actor: 'human' | 'supervisor';
  dataJson: string | null;
  at: string;
}

export type AgentRole = 'spec' | 'build' | 'review';

export interface Finding { severity: 'blocking' | 'major' | 'minor'; file?: string; line?: number; text: string }

export interface AgentResult {
  ok: boolean;
  kind: 'done' | 'needs_human' | 'rate_limited' | 'error' | 'timeout';
  summary: string;
  question?: string;
  findings?: Finding[];
  costUsd?: number;
  resetAt?: string;
  text?: string; // full final result text (the spec run stores it minus the contract line)
}
