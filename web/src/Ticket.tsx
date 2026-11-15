import { useCallback, useEffect, useState } from 'react';
import { act, getDetail, getLog, type Detail, type Finding } from './api.ts';

const btn = 'rounded border px-3 py-1 disabled:opacity-40 ';
const parse = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const SEV_ORDER = ['blocking', 'major', 'minor'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mt-4"><h2 className="mb-1 font-semibold">{title}</h2>{children}</section>;
}
const Pre = ({ children }: { children: React.ReactNode }) =>
  <pre className="max-h-96 overflow-auto rounded border bg-white p-2 text-xs whitespace-pre-wrap">{children}</pre>;

function Diff({ text }: { text: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded border bg-white p-2 text-xs">
      {text.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') ? 'bg-green-100 text-green-900' : l.startsWith('-') ? 'bg-red-100 text-red-900' : l.startsWith('@') ? 'text-blue-700' : ''}>{l || ' '}</div>
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
  return <Pre>{text || '(no log yet)'}</Pre>;
}

export function TicketPage({ id, tick, onChange }: { id: string; tick: number; onChange: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => getDetail(id).then((x) => { setD(x); setErr(''); }, (e) => setErr(e.message)), [id]);
  useEffect(() => { load(); }, [load, tick]);

  const run = async (action: string, body: object = {}, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try { await act(id, action, body); setErr(''); setNote(''); setAnswer(''); await load(); onChange(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!d || d.ticket.id !== id) return <div>{err ? <p role="alert" className="text-red-800">{err}</p> : 'Loading...'}<p><a href="#/" className="text-blue-700 underline">Back</a></p></div>;
  const t = d.ticket;
  const latest = d.runs[d.runs.length - 1];
  const checks = d.runs.filter((r) => r.kind === 'verify').pop();
  const review = d.runs.filter((r) => r.kind === 'review').pop();
  const findings = ((parse(review?.resultJson ?? null).findings ?? []) as Finding[]).slice().sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const terminal = t.state === 'done' || t.state === 'cancelled';

  return (
    <div className="max-w-4xl">
      <a href="#/" className="text-blue-700 underline">Back to board</a>
      <h1 className="mt-2 text-xl font-semibold"><span className="font-mono">{t.id}</span> {t.title}</h1>
      <p className="text-sm text-gray-600">State: <b>{t.state}</b> | attempt {t.attempt}/{t.maxAttempts}{t.headSha && <> | head {t.headSha.slice(0, 8)}</>}</p>
      {t.blockedReason && <p className="mt-2 rounded bg-yellow-100 p-2">Blocked: {t.blockedReason}</p>}
      {t.humanNote && <p className="mt-2 rounded bg-blue-100 p-2">Note: {t.humanNote}</p>}
      {err && <p role="alert" className="mt-2 rounded bg-red-100 p-2 text-red-800">{err}</p>}

      <Section title="Actions">
        <div className="flex flex-wrap gap-2">
          {t.state === 'awaiting_approval' && <button className={btn + 'bg-green-600 text-white'} disabled={busy} onClick={() => run('approve', {}, `Approve ${t.id}?`)}>Approve</button>}
          {t.state === 'blocked' && <button className={btn} disabled={busy} onClick={() => run('retry')}>Retry</button>}
          {t.state === 'blocked' && <button className={btn} disabled={busy} onClick={() => run('reset', {}, `Reset ${t.id}? This discards its work.`)}>Reset</button>}
          {!terminal && <button className={btn + 'text-red-700'} disabled={busy} onClick={() => run('cancel', {}, `Cancel ${t.id}?`)}>Cancel</button>}
        </div>
        {t.state === 'awaiting_approval' && (
          <div className="mt-2">
            <label htmlFor="note" className="block text-sm">Rejection note</label>
            <textarea id="note" className="w-full rounded border p-1" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            <button className={btn} disabled={busy || !note.trim()} onClick={() => run('reject', { note })}>Reject</button>
          </div>
        )}
        {t.state === 'blocked' && (
          <div className="mt-2">
            <label htmlFor="answer" className="block text-sm">Answer</label>
            <textarea id="answer" className="w-full rounded border p-1" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <button className={btn} disabled={busy || !answer.trim()} onClick={() => run('answer', { text: answer })}>Answer</button>
          </div>
        )}
      </Section>

      <Section title="Spec"><Pre>{t.spec ?? t.body}</Pre></Section>
      {d.diff && <Section title="Diff"><Diff text={d.diff} /></Section>}
      {checks && <Section title={`Checks (${checks.state})`}><Pre>{checks.resultJson ?? '(no result)'}</Pre></Section>}
      {findings.length > 0 && (
        <Section title="Review findings">
          <ul className="space-y-1">
            {findings.map((f, i) => (
              <li key={i} className="rounded border bg-white p-2 text-sm">
                <b className={f.severity === 'blocking' ? 'text-red-700' : f.severity === 'major' ? 'text-orange-700' : 'text-gray-600'}>{f.severity}</b>
                {f.file && <span className="font-mono"> {f.file}{f.line ? `:${f.line}` : ''}</span>}: {f.text}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {latest && <Section title={`Log (run ${latest.id}, ${latest.kind}, ${latest.state})`}><LogTail runId={latest.id} live={latest.state === 'running'} /></Section>}
      <Section title="Timeline">
        <ul className="text-sm">
          {d.events.map((e) => (
            <li key={e.id}><span className="text-gray-500">{e.at}</span> {e.type}{e.toState && <>: {e.fromState ?? '-'} to {e.toState}</>} ({e.actor}){e.dataJson && <span className="font-mono text-xs text-gray-600"> {e.dataJson}</span>}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
