import React, { useState } from 'react';
import { ToolBody, toolSummary } from './ToolCard.jsx';
import { Button } from '../ui/index.jsx';

function alwaysLabel(suggestions) {
  if (!Array.isArray(suggestions) || !suggestions.length) return null;
  const s = suggestions[0];
  if (s.type === 'setMode' && s.mode === 'acceptEdits') return 'Allow all edits this session';
  if (s.type === 'addRules') {
    const r = s.rules?.[0];
    const rule = r ? (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName) : '';
    return `Always allow ${rule}`.slice(0, 60);
  }
  if (s.type === 'addDirectories') return 'Always allow this folder';
  return 'Always allow';
}

function Questions({ input, onAnswer }) {
  const qs = input.questions || [];
  const [answers, setAnswers] = useState({});
  const [other, setOther] = useState({});
  const toggle = (q, label) => {
    setAnswers((a) => {
      const cur = a[q.question] || [];
      if (q.multiSelect) return { ...a, [q.question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      return { ...a, [q.question]: [label] };
    });
  };
  const ready = qs.every((q) => (answers[q.question] || []).length || other[q.question]?.trim());
  const submit = () => {
    const out = {};
    for (const q of qs) {
      const picked = [...(answers[q.question] || [])];
      if (other[q.question]?.trim()) picked.push(other[q.question].trim());
      out[q.question] = picked.join(', ');
    }
    onAnswer(out);
  };
  return (
    <div className="questions">
      {qs.map((q) => (
        <div key={q.question} className="question">
          {q.header && <div className="qheader">{q.header}</div>}
          <div className="qtext">{q.question}</div>
          <div className="qopts">
            {(q.options || []).map((o) => {
              const on = (answers[q.question] || []).includes(o.label);
              return (
                <button key={o.label} className={`qopt ${on ? 'on' : ''}`} onClick={() => toggle(q, o.label)}>
                  <span className="qlabel">{o.label}</span>
                  {o.description && <span className="qdesc">{o.description}</span>}
                </button>
              );
            })}
            <input
              className="field qother"
              placeholder="Other…"
              value={other[q.question] || ''}
              onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))}
            />
          </div>
        </div>
      ))}
      <div className="perm-actions">
        <Button variant="primary" disabled={!ready} onClick={submit}>
          Submit answers
        </Button>
      </div>
    </div>
  );
}

export default function Permission({ perm, cwd, onAnswer, onMode, showBody = true }) {
  const [denyMsg, setDenyMsg] = useState('');
  const [denying, setDenying] = useState(false);
  if (perm.done) {
    const label = { allow: 'Allowed', deny: 'Denied', cancelled: 'Cancelled' }[perm.done] || perm.done;
    return <div className={`perm-done ${perm.done}`}>{label}{perm.tool === 'AskUserQuestion' && perm.done === 'allow' ? ' (answered)' : ''}</div>;
  }
  const answer = (behavior, extra = {}) => onAnswer({ reqId: perm.reqId, behavior, ...extra });

  if (perm.tool === 'AskUserQuestion') {
    return (
      <div className="perm ask">
        <div className="perm-title">Claude has a question</div>
        <Questions input={perm.input} onAnswer={(answers) => answer('allow', { updatedInput: { ...perm.input, answers } })} />
        <button className="link-btn" onClick={() => answer('deny', { message: 'The user declined to answer.' })}>
          Skip
        </button>
      </div>
    );
  }

  if (perm.tool === 'ExitPlanMode') {
    return (
      <div className="perm plan">
        <div className="perm-title">Ready to code?</div>
        {showBody && <ToolBody name={perm.tool} input={perm.input} cwd={cwd} />}
        <div className="perm-actions">
          <Button
            variant="primary"
            onClick={() => {
              onMode('acceptEdits');
              answer('allow');
            }}
          >
            Yes, auto-accept edits
          </Button>
          <Button onClick={() => {
            onMode('default');
            answer('allow');
          }}>
            Yes, ask before edits
          </Button>
          <Button onClick={() => setDenying(true)}>
            Keep planning
          </Button>
        </div>
        {denying && (
          <form className="deny-form fields" onSubmit={(e) => (e.preventDefault(), answer('deny', { message: denyMsg || 'Keep planning.' }))}>
            <input autoFocus placeholder="What should change in the plan?" value={denyMsg} onChange={(e) => setDenyMsg(e.target.value)} />
            <Button size="sm">Send</Button>
          </form>
        )}
      </div>
    );
  }

  // Self-update: one approval for one commit, so there is no "Always allow" (the server ignores it).
  if (perm.tool === 'mcp__server__update_server') {
    const { to_commit, restart_runner, reason } = perm.input || {};
    return (
      <div className="perm">
        <div className="perm-title">
          Update the server to <code>{to_commit}</code> from main{restart_runner ? ' and restart the runner' : ''}?
        </div>
        {reason && <div className="perm-reason">{reason}</div>}
        <div className="perm-reason muted">
          Rebuilds and restarts the web server; chats keep running.
          {restart_runner ? ' Restarting the runner waits until no chat is working.' : ''} It rolls back if the new server fails its health check.
        </div>
        <div className="perm-actions">
          <Button variant="primary" onClick={() => answer('allow')}>
            Update
          </Button>
          <Button onClick={() => setDenying((d) => !d)}>Deny</Button>
        </div>
        {denying && (
          <form className="deny-form fields" onSubmit={(e) => (e.preventDefault(), answer('deny', { message: denyMsg || undefined }))}>
            <input autoFocus placeholder="Tell Claude why (optional)" value={denyMsg} onChange={(e) => setDenyMsg(e.target.value)} />
            <Button size="sm">Deny</Button>
          </form>
        )}
      </div>
    );
  }

  const always = alwaysLabel(perm.suggestions);
  return (
    <div className="perm">
      <div className="perm-title">
        Allow <b>{perm.tool}</b>
        {!showBody && <span className="muted"> · {toolSummary(perm.tool, perm.input, cwd)}</span>}?
      </div>
      {perm.reason && typeof perm.reason === 'string' && <div className="perm-reason muted">{perm.reason}</div>}
      {showBody && <ToolBody name={perm.tool} input={perm.input} cwd={cwd} />}
      <div className="perm-actions">
        <Button variant="primary" onClick={() => answer('allow')}>
          Allow
        </Button>
        {always && (
          <Button onClick={() => answer('allow', { always: true })}>
            {always}
          </Button>
        )}
        <Button onClick={() => setDenying((d) => !d)}>
          Deny
        </Button>
      </div>
      {denying && (
        <form className="deny-form fields" onSubmit={(e) => (e.preventDefault(), answer('deny', { message: denyMsg || undefined }))}>
          <input autoFocus placeholder="Tell Claude what to do instead (optional)" value={denyMsg} onChange={(e) => setDenyMsg(e.target.value)} />
          <Button size="sm">Deny</Button>
        </form>
      )}
    </div>
  );
}
