import { useCallback, useEffect, useState } from 'react';
import { act, getDetail, getLog, type Detail, type Finding } from './api.ts';
import { ago, StatePill } from './Board.tsx';

const btn = 'rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ';
const ghost = btn + 'border border-white/10 text-zinc-300 hover:bg-white/5 hover:text-white';
const parse = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const SEV_ORDER = ['blocking', 'major', 'minor'];
const SEV = { blocking: 'bg-rose-500/15 text-rose-300', major: 'bg-amber-500/15 text-amber-300', minor: 'bg-white/5 text-zinc-400' };

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-zinc-900/40">
      <h2 className="flex items-center justify-between border-b border-white/5 px-4 py-2.5 text-xs font-medium tracking-wide text-zinc-400 uppercase">{title}{right}</h2>
      <div className="p-4">{children}</div>
    </section>
  );
}
const Pre = ({ children }: { children: React.ReactNode }) =>
  <pre className="max-h-96 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-zinc-300">{children}</pre>;

function Diff({ text }: { text: string }) {
  return (
    <pre className="-m-4 max-h-[32rem] overflow-auto py-2 font-mono text-xs leading-relaxed">
      {text.split('\n').map((l, i) => (
        <div key={i} className={'px-4 ' + (l.startsWith('+') ? 'bg-emerald-500/10 text-emerald-300' : l.startsWith('-') ? 'bg-rose-500/10 text-rose-300' : l.startsWith('@') ? 'text-sky-400' : 'text-zinc-400')}>{l || ' '}</div>
      ))}
    </pre>
  );
}

function LogTail({ runId, live }: { runId: number; live: boolean }) {
  const [text, setText] = useState('');
  useEffect(() => {
    setText('');
    let offset = 0, stop = false;
    const poll = async () => {
      try {
        const r = await getLog(runId, offset);
        if (stop) return;
        offset = r.offset;
        if (r.text) setText((t) => t + r.text);
      } catch { /* retry next tick */ }
    };
    poll();
    const timer = live ? setInterval(poll, 2000) : undefined;
    return () => { stop = true; clearInterval(timer); };
  }, [runId, live]);
  return <Pre>{text || <span className="text-zinc-600">(no log yet)</span>}</Pre>;
}

export function TicketPage({ id, tick, onChange }: { id: string; tick: number; onChange: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [answer, setAnswer] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => getDetail(id).then((x) => { setD(x); setErr(''); }, (e) => setErr(e.message)), [id]);
  useEffect(() => { load(); }, [load, tick]);

  const run = async (action: string, body: object = {}, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try { await act(id, action, body); setErr(''); setNote(''); setAnswer(''); setRejecting(false); await load(); onChange(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const back = <a href="#/" className="text-sm text-zinc-500 transition hover:text-zinc-200">← Board</a>;
  if (!d || d.ticket.id !== id) return <div className="space-y-3">{back}{err ? <p role="alert" className="text-rose-300">{err}</p> : <p className="text-zinc-500">Loading…</p>}</div>;
  const t = d.ticket;
  const latest = d.runs[d.runs.length - 1];
  const checks = d.runs.filter((r) => r.kind === 'verify').pop();
  const failed = parse(checks?.resultJson ?? null) as { check?: string; code?: number; timedOut?: boolean; failureTail?: string };
  const review = d.runs.filter((r) => r.kind === 'review').pop();
  const findings = ((parse(review?.resultJson ?? null).findings ?? []) as Finding[]).slice().sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const terminal = t.state === 'done' || t.state === 'cancelled';
  const field = 'w-full rounded-lg border border-white/10 bg-zinc-950 p-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none';

  return (
    <div className="mx-auto max-w-6xl">
      {back}
      <div className="mt-4 mb-6">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-zinc-500">{t.id}</span>
          <StatePill state={t.state} />
        </div>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-50">{t.title}</h1>
      </div>

      {t.blockedReason && <p className="mb-4 rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-4 py-3 text-sm text-rose-200"><span className="font-medium">Blocked · </span>{t.blockedReason}</p>}
      {t.humanNote && <p className="mb-4 rounded-lg border border-sky-500/25 bg-sky-500/[0.07] px-4 py-3 text-sm text-sky-200"><span className="font-medium">Note · </span>{t.humanNote}</p>}
      {err && <p role="alert" className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{err}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-4">
          <Card title={t.spec ? 'Spec' : 'Request'}><Pre>{t.spec ?? t.body}</Pre></Card>
          {findings.length > 0 && (
            <Card title="Review findings" right={<span className="font-mono normal-case">{findings.length}</span>}>
              <ul className="-my-2 divide-y divide-white/5">
                {findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-3 py-2.5 text-sm">
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${SEV[f.severity]}`}>{f.severity}</span>
                    <div className="min-w-0">
                      <div className="text-zinc-200">{f.text}</div>
                      {f.file && <div className="mt-0.5 font-mono text-xs text-zinc-500">{f.file}{f.line ? `:${f.line}` : ''}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {d.diff && <Card title="Diff"><Diff text={d.diff} /></Card>}
          {checks && (
            <Card title="Checks">
              {checks.state === 'succeeded' ? <p className="text-sm text-emerald-300">✓ All checks passed</p>
                : checks.state === 'running' ? <p className="text-sm text-amber-300">Running…</p>
                : <>
                    <p className="mb-2 text-sm text-rose-300">✕ {failed.check ?? 'check'} {failed.timedOut ? 'timed out' : `failed (exit ${failed.code ?? '?'})`}</p>
                    {failed.failureTail && <Pre>{failed.failureTail}</Pre>}
                  </>}
            </Card>
          )}
          {latest && (
            <Card title="Log" right={<span className="normal-case">{latest.kind} · run {latest.id} · {latest.state}</span>}>
              <LogTail runId={latest.id} live={latest.state === 'running'} />
            </Card>
          )}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          {!terminal && (
            <Card title="Actions">
              <div className="space-y-3">
                {t.state === 'awaiting_approval' && (
                  <div className="flex gap-2">
                    <button className={btn + 'flex-1 bg-violet-600 text-white hover:bg-violet-500'} disabled={busy} onClick={() => run('approve', {}, `Approve ${t.id}?`)}>Approve</button>
                    <button className={ghost + ' flex-1'} disabled={busy} onClick={() => setRejecting((r) => !r)} aria-expanded={rejecting}>Reject…</button>
                  </div>
                )}
                {rejecting && t.state === 'awaiting_approval' && (
                  <div className="space-y-2">
                    <label htmlFor="note" className="sr-only">Rejection note</label>
                    <textarea id="note" className={field} rows={4} placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
                    <button className={ghost + ' w-full'} disabled={busy || !note.trim()} onClick={() => run('reject', { note })}>Send back to build</button>
                  </div>
                )}
                {t.state === 'blocked' && (
                  <>
                    <div className="space-y-2">
                      <label htmlFor="answer" className="sr-only">Answer</label>
                      <textarea id="answer" className={field} rows={4} placeholder="Answer the agent…" value={answer} onChange={(e) => setAnswer(e.target.value)} />
                      <button className={btn + 'w-full bg-violet-600 text-white hover:bg-violet-500'} disabled={busy || !answer.trim()} onClick={() => run('answer', { text: answer })}>Answer</button>
                    </div>
                    <div className="flex gap-2">
                      <button className={ghost + ' flex-1'} disabled={busy} onClick={() => run('retry')}>Retry</button>
                      <button className={ghost + ' flex-1'} disabled={busy} onClick={() => run('reset', {}, `Reset ${t.id}? This discards its work.`)}>Reset</button>
                    </div>
                  </>
                )}
                <button className={btn + 'w-full text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300'} disabled={busy} onClick={() => run('cancel', {}, `Cancel ${t.id}?`)}>Cancel ticket</button>
              </div>
            </Card>
          )}

          <Card title="Details">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-zinc-500">Repo</dt><dd className="truncate text-zinc-200">{t.repoId}</dd>
              <dt className="text-zinc-500">Attempt</dt><dd className="text-zinc-200">{t.attempt} / {t.maxAttempts}</dd>
              {t.branch && <><dt className="text-zinc-500">Branch</dt><dd className="truncate font-mono text-xs leading-5 text-zinc-300">{t.branch}</dd></>}
              {t.headSha && <><dt className="text-zinc-500">Head</dt><dd className="font-mono text-xs leading-5 text-zinc-300">{t.headSha.slice(0, 8)}</dd></>}
              <dt className="text-zinc-500">Updated</dt><dd className="text-zinc-200">{ago(t.updatedAt)}</dd>
            </dl>
          </Card>

          <Card title="Timeline">
            <ol className="relative space-y-3 border-l border-white/10 pl-4">
              {d.events.map((e) => (
                <li key={e.id} className="relative text-sm">
                  <span className="absolute top-1.5 -left-[19px] size-1.5 rounded-full bg-zinc-500" />
                  <div className="text-zinc-300">{e.toState ? <>{e.fromState?.replace('_', ' ') ?? '–'} → <span className="text-zinc-100">{e.toState.replace('_', ' ')}</span></> : e.type}</div>
                  <div className="text-xs text-zinc-600" title={e.at}>{e.actor} · {ago(e.at)}</div>
                  {e.dataJson && <div className="mt-1 font-mono text-[11px] break-all text-zinc-500">{e.dataJson}</div>}
                </li>
              ))}
              {d.events.length === 0 && <li className="text-sm text-zinc-600">No events yet</li>}
            </ol>
          </Card>
        </aside>
      </div>
    </div>
  );
}
