import { readFileSync, existsSync } from 'node:fs';
import type { AgentResult, AgentRole, Finding } from './types.ts';
import type { Sandbox } from './sandbox.ts';

const MIN = 60_000;
export const TIMEOUTS: Record<AgentRole, number> = { spec: 15 * MIN, review: 15 * MIN, build: 45 * MIN };

const err = (summary: string): AgentResult => ({ ok: false, kind: 'error', summary });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseFindings(v: unknown): Finding[] | null {
  if (!Array.isArray(v)) return null;
  const out: Finding[] = [];
  for (const f of v) {
    if (!isObj(f) || !['blocking', 'major', 'minor'].includes(f.severity as string) || typeof f.text !== 'string') return null;
    if (f.file !== undefined && typeof f.file !== 'string') return null;
    if (f.line !== undefined && typeof f.line !== 'number') return null;
    out.push({ severity: f.severity as Finding['severity'], text: f.text, file: f.file as string | undefined, line: f.line as number | undefined });
  }
  return out;
}

// Trust boundary: everything parsed here comes from the worker.
export function parseStream(jsonl: string): AgentResult {
  const line = jsonl.split('\n').filter((l) => l.includes('"type":"result"')).pop();
  if (!line) return err('no result event in agent output');
  let ev: Record<string, unknown>;
  try {
    const p = JSON.parse(line);
    if (!isObj(p) || p.type !== 'result') return err('no result event in agent output');
    ev = p;
  } catch { return err('unparseable result event'); }
  const text = typeof ev.result === 'string' ? ev.result : '';
  const costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined;
  if (ev.is_error === true && (ev.api_error_status === 429 || /usage limit|rate limit/i.test(text))) {
    const m = text.match(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)/);
    const d = m ? new Date(m[0]) : null;
    return { ok: false, kind: 'rate_limited', summary: text || 'rate limited', costUsd, resetAt: d && !isNaN(d.getTime()) ? d.toISOString() : undefined };
  }
  if (ev.is_error === true) return { ok: false, kind: 'error', summary: `agent error: ${text.slice(0, 500) || 'unknown'}`, costUsd };
  const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!last) return err('result text is empty');
  let o: unknown;
  try { o = JSON.parse(last); } catch { return err(`final line of result is not JSON: ${last.slice(0, 200)}`); }
  if (!isObj(o) || (o.status !== 'done' && o.status !== 'needs_human') || typeof o.summary !== 'string') {
    return err('final JSON has invalid shape (need status done|needs_human and string summary)');
  }
  const findings = o.findings === undefined ? undefined : parseFindings(o.findings);
  if (findings === null) return err('final JSON has invalid findings');
  if (o.question !== undefined && typeof o.question !== 'string') return err('final JSON has invalid question');
  const res: AgentResult = { ok: o.status === 'done', kind: o.status, summary: o.summary, costUsd };
  if (o.question !== undefined) res.question = o.question;
  if (findings) res.findings = findings;
  return res;
}

export async function runAgent(
  sb: Sandbox, name: string, role: AgentRole, prompt: string, logPath: string,
  opts: { systemPrompt?: string; onPid?: (pid: number) => void; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AgentResult> {
  const argv = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (opts.systemPrompt) argv.push('--append-system-prompt', opts.systemPrompt);
  const r = await sb.exec(name, argv, { stdin: prompt, timeoutMs: opts.timeoutMs ?? TIMEOUTS[role], logPath, onPid: opts.onPid, signal: opts.signal });
  if (r.timedOut) return { ok: false, kind: 'timeout', summary: 'timed out' };
  const parsed = parseStream(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
  if (parsed.kind === 'error' && r.code !== 0) parsed.summary += ` (exit code ${r.code})`;
  return parsed;
}
