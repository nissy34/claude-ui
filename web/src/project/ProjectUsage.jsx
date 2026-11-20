import React, { useRef, useState } from 'react';
import { Menu, useDismiss } from '../ui/index.jsx';
import { contextWindowFor, fmtReset, windowName } from '../chat/Composer.jsx';

// 141.7M, 66M, 812k: compact token counts like claude.ai's usage popover.
export function fmtTok(n) {
  if (!n) return '0';
  const f = (v, u) => `${v >= 100 ? Math.round(v) : +v.toFixed(1)}${u}`;
  if (n >= 1e9) return f(n / 1e9, 'B');
  if (n >= 1e6) return f(n / 1e6, 'M');
  if (n >= 1e3) return f(n / 1e3, 'k');
  return String(n);
}

/**
 * Per-thread usage, most first, with the project chat as its own row. Shares go by cost, which
 * is known for every turn; token counts show where they were recorded (turns since this shipped).
 */
export function usageByThread(project) {
  const rows = project.threads.map((t) => ({ id: t.id, title: t.title, status: t.status, tokens: t.tokens || 0, cost: t.cost || 0 }));
  if (project.usage.coordinator || project.usage.coordinatorTokens) rows.push({ id: null, title: 'Project chat', status: project.coordinatorBusy ? 'working' : 'idle', tokens: project.usage.coordinatorTokens || 0, cost: project.usage.coordinator || 0 });
  const byCost = project.usage.total > 0;
  const total = byCost ? project.usage.total : rows.reduce((n, r) => n + r.tokens, 0);
  for (const r of rows) r.share = total ? (byCost ? r.cost : r.tokens) / total : 0;
  return rows.filter((r) => r.cost || r.tokens).sort((a, b) => b.share - a.share || b.tokens - a.tokens);
}

const amount = (r) => (r.tokens ? fmtTok(r.tokens) : `$${r.cost.toFixed(2)}`);

function Ring({ pct }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.2" />
      {pct > 0 && <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 9 9)" strokeLinecap="round" />}
    </svg>
  );
}

function Bar({ label, right, pct, hot }) {
  return (
    <div className="usage-row">
      <div className="usage-line">
        <b>{label}</b>
        <span className="muted">{right}</span>
      </div>
      <div className={`meter ${hot ? 'hot' : ''}`}>
        <span style={{ width: `${Math.min(100, pct * 100)}%` }} />
      </div>
    </div>
  );
}

/**
 * The context ring in a project composer (the project chat or a thread). It fills with that
 * conversation's context; a click shows the context, the plan usage limits and the project's
 * threads using the most, like claude.ai's projects.
 */
export function ProjectUsageRing({ project, context, currentThread, onOpenThread, onFullUsage }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useDismiss(open, () => setOpen(false), root);
  const used = context?.used || 0;
  const win = used ? contextWindowFor({ used, window: context.window, compactWindow: context.compactWindow, model: context.model }) : 0;
  const pct = win ? Math.min(1, used / win) : 0;
  const limits = Object.entries(project.rateLimit || {}).filter(([, w]) => w && typeof w.utilization === 'number');
  const top = usageByThread(project).slice(0, 6);
  const totalTokens = project.usage.tokens || 0;
  return (
    <div className="menu-wrap pj-usage-wrap" ref={root}>
      <button type="button" className={`chip icon ctx-ring ${pct > 0.8 ? 'hot' : ''}`} title={used ? `${Math.round(pct * 100)}% of context used` : 'Usage'} aria-label="Context and usage" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Ring pct={pct} />
      </button>
      {open && (
        <Menu place="up" align="right" className="usage-pop pj-usage-pop">
          {used > 0 && (
            <>
              <Bar label={currentThread ? 'Thread context' : 'Context'} right={`${fmtTok(used)} of ${fmtTok(win)} · ${Math.round(pct * 100)}%`} pct={pct} hot={pct > 0.8} />
              <div className="sep" />
            </>
          )}
          {limits.length > 0 && (
            <>
              <div className="pad usage-title">Plan usage limits</div>
              {limits.map(([k, w]) => (
                <Bar key={k} label={windowName(k)} right={`${fmtReset(w.resetsAt)} ${Math.round(w.utilization * 100)}%`} pct={w.utilization} />
              ))}
              <div className="sep" />
            </>
          )}
          <div className="pad usage-title pj-usage-head">
            <span>Threads using the most</span>
            <span>{totalTokens ? `${fmtTok(totalTokens)} total` : `$${project.usage.total.toFixed(2)} total`}</span>
          </div>
          {top.length === 0 && <div className="pad muted small">No usage yet.</div>}
          {top.map((t) => (
            <button key={t.id || 'chat'} className={`pj-usage-thread ${t.id && t.id === currentThread ? 'on' : ''}`} disabled={!t.id} onClick={() => (setOpen(false), onOpenThread?.(t.id))}>
              <span className={`pj-usage-dot ${t.status === 'working' ? 'live' : ''}`} />
              <span className="pj-usage-name">{t.title}</span>
              <span className="muted pj-usage-amt">
                {amount(t)} · {Math.round(t.share * 100)}%
              </span>
            </button>
          ))}
          <div className="sep" />
          <button className="pj-usage-full" onClick={() => (setOpen(false), onFullUsage?.())}>
            <span>See full project usage</span>
            <span className="muted">→</span>
          </button>
        </Menu>
      )}
    </div>
  );
}
