import React, { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from './markdown.js';
import Linkify from './Linkify.jsx';

// Desktop's side chat (/btw, Ctrl/⌘+;): ask about the conversation without adding to it.
// Answers come from a throwaway, read-only fork of the chat; nothing is saved.
export default function SideChat({ sessionId, initial, onClose }) {
  const [list, setList] = useState([]); // { q, a, error, live }
  const [q, setQ] = useState('');
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const busy = list.some((x) => x.live);

  const ask = async (question) => {
    question = question.trim();
    if (!question || busy) return;
    const history = list.filter((x) => x.a && !x.error).map(({ q: hq, a }) => ({ q: hq, a }));
    setList((l) => [...l, { q: question, a: '', live: true }]);
    setQ('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const patch = (fn) => setList((l) => l.map((x, i) => (i === l.length - 1 ? fn(x) : x)));
    try {
      const r = await fetch(`/api/sessions/${sessionId}/btw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, history }), signal: ctrl.signal, credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.d) patch((x) => ({ ...x, a: x.a + m.d }));
          if (m.error) patch((x) => ({ ...x, error: m.error }));
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') patch((x) => ({ ...x, error: e.message }));
    } finally {
      patch((x) => ({ ...x, live: false }));
      abortRef.current = null;
    }
  };

  useEffect(() => {
    if (initial) ask(initial);
    else inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [list]);

  return (
    <div className="side-chat" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="side-chat-head">
        <span>Side chat</span>
        <span className="muted">Not added to the conversation</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="side-chat-body">
        {list.length === 0 && <div className="muted side-chat-empty">Ask a quick question about this chat: what a change does, where something lives, what Claude meant. Claude answers from the conversation and can read files, but won't change anything.</div>}
        {list.map((x, i) => (
          <div key={i} className="sc-pair">
            <div className="sc-q"><Linkify text={x.q} /></div>
            <div className="sc-a">
              {x.a ? <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(x.a) }} /> : x.live ? <span className="spinner" /> : null}
              {x.error && <div className="sys-error">{x.error}</div>}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="side-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={busy ? 'Answering…' : 'Ask on the side…'} />
        {busy ? (
          <button type="button" className="btn small" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="btn small primary" disabled={!q.trim()}>
            Ask
          </button>
        )}
      </form>
    </div>
  );
}
