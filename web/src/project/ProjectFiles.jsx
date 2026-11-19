import React, { useEffect, useRef, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { Button, Card, Input, Spinner, Textarea } from '../ui/index.jsx';
import { confirmDialog } from '../ui/dialogs.jsx';
import { Md } from './ProjectCards.jsx';

const kb = (n) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

/** [[name]] links between memory files become clickable links (#mem:name). */
const withLinks = (text) => String(text || '').replace(/\[\[([a-z0-9][a-z0-9-]*)\]\]/gi, (m, n) => `[${n}](#mem:${n.toLowerCase()})`);
const TYPE_LABEL = { user: 'User', feedback: 'Feedback', project: 'Project', reference: 'Reference' };

/** Project memory: MEMORY.md (read by every thread) and one file per subject. */
export function ProjectMemory({ project, onError, initial }) {
  const [files, setFiles] = useState(null);
  const [index, setIndex] = useState(null); // { size, cap, pinned, lines }
  const [pinEdit, setPinEdit] = useState(null);
  const [ask, setAsk] = useState('');
  const [asked, setAsked] = useState(false);
  const [open, setOpen] = useState(null); // { name, description, type, modified, content, version, isNew, editing }
  useEffect(() => {
    if (initial)
      api(`/api/cprojects/${project.id}/memory/${encodeURIComponent(initial)}`)
        .then((r) => setOpen({ ...r, editing: false }))
        .catch(onError);
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = () =>
    api(`/api/cprojects/${project.id}/memory`)
      .then((r) => (setFiles(r.files), setIndex(r.index || null)))
      .catch(onError);
  useEffect(() => {
    load();
  }, [project.id, project.lastActivity]); // eslint-disable-line react-hooks/exhaustive-deps
  const openFile = (name) =>
    api(`/api/cprojects/${project.id}/memory/${encodeURIComponent(name)}`)
      .then((r) => setOpen({ ...r, editing: false }))
      .catch(onError);
  const onLink = (e) => {
    const a = e.target.closest?.('a');
    const href = a?.getAttribute('href') || '';
    if (href.startsWith('#mem:')) {
      e.preventDefault();
      openFile(href.slice(5));
    }
  };
  const save = async () => {
    try {
      const r = await api(`/api/cprojects/${project.id}/memory/${encodeURIComponent(open.name)}`, { method: 'PUT', body: { description: open.description, content: open.content, type: open.type || undefined, version: open.isNew ? undefined : open.version } });
      setOpen({ ...open, name: r.name, version: r.version, isNew: false, editing: false, modified: new Date().toISOString() });
      load();
    } catch (e) {
      onError(e.status === 409 ? new Error('Someone changed this file while you edited it. Reopen it to see the latest text.') : e);
    }
  };
  const del = async () => {
    if (!(await confirmDialog(`Delete the memory file "${open.name}"?`, { title: 'Delete memory', ok: 'Delete', danger: true }))) return;
    await api(`/api/cprojects/${project.id}/memory/${encodeURIComponent(open.name)}`, { method: 'DELETE' }).catch(onError);
    setOpen(null);
    load();
  };
  const savePinned = async () => {
    try {
      setIndex(await api(`/api/cprojects/${project.id}/memory-pinned`, { method: 'PUT', body: { text: pinEdit } }));
      setPinEdit(null);
    } catch (e) {
      onError(e);
    }
  };
  const sendAsk = async () => {
    const t = ask.trim();
    if (!t) return;
    try {
      await api(`/api/cprojects/${project.id}/messages`, { method: 'POST', body: { text: `About project memory: ${t}` } });
      setAsk('');
      setAsked(true);
    } catch (e) {
      onError(e);
    }
  };
  if (open)
    return (
      <div className="pj-overview">
        <div className="pj-overview-inner fields pj-form">
          <div className="pj-overview-bar">
            <button className="linklike" onClick={() => setOpen(null)}>
              ◂ Memory
            </button>
            <span className="spacer" />
            {!open.editing && (
              <Button size="sm" onClick={() => setOpen({ ...open, editing: true })}>
                Edit
              </Button>
            )}
            {!open.isNew && (
              <Button size="sm" variant="danger" onClick={del}>
                Delete
              </Button>
            )}
          </div>
          {open.editing ? (
            <>
              <label>
                Name
                <Input mono value={open.name} disabled={!open.isNew} onChange={(e) => setOpen({ ...open, name: e.target.value })} placeholder="deploy-process" />
              </label>
              <label>
                Description <span className="muted small">(one line, shown in MEMORY.md, which every thread reads)</span>
                <Input value={open.description} onChange={(e) => setOpen({ ...open, description: e.target.value })} />
              </label>
              <label>
                Type
                <select className="field" value={open.type || ''} onChange={(e) => setOpen({ ...open, type: e.target.value || null })}>
                  <option value="">None</option>
                  {Object.entries(TYPE_LABEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Content <span className="muted small">(Markdown, under 4 KB; link other files with [[their-name]])</span>
                <Textarea mono rows={14} value={open.content} onChange={(e) => setOpen({ ...open, content: e.target.value })} />
              </label>
              <div className="pj-save">
                <Button variant="primary" onClick={save} disabled={!open.name.trim() || !open.description.trim()}>
                  Save
                </Button>
                <span className="muted small">{new Blob([open.content]).size} bytes</span>
              </div>
            </>
          ) : (
            <Card className="pj-memfile" onClick={onLink}>
              <div className="pj-memfield">
                <span className="muted small">Name</span>
                <span className="pj-thread-title">{open.name}</span>
              </div>
              <div className="pj-memfield">
                <span className="muted small">Description</span>
                <span>{open.description}</span>
              </div>
              <div className="pj-memfield">
                <span className="muted small">Metadata</span>
                <span className="muted small">
                  {open.type ? `type: ${TYPE_LABEL[open.type] || open.type} · ` : ''}
                  {open.modified ? `modified ${timeAgo(Date.parse(open.modified))}` : ''}
                </span>
              </div>
              <div className="pj-membody">
                <Md text={withLinks(open.content)} />
              </div>
            </Card>
          )}
        </div>
      </div>
    );
  const pct = index ? Math.min(100, (index.size / index.cap) * 100) : 0;
  return (
    <div className="pj-overview">
      <div className="pj-overview-inner">
        <div className="pj-mem-sec">Read every thread</div>
        <Card className="pj-memindex">
          <div className="pj-memindex-head">
            <span className="pj-thread-title">MEMORY.md</span>
            <span className="spacer" />
            <span className="muted small">
              {index ? `${kb(index.size)} of 16 KB` : ''}
            </span>
          </div>
          <div className="pj-membar">
            <span style={{ width: `${Math.max(pct, 0.5)}%` }} className={pct > 85 ? 'warn' : ''} />
          </div>
          <div className="muted small">One line per file below, kept by Claude. The pinned part is yours: facts and links that need no file of their own.</div>
          {pinEdit !== null ? (
            <>
              <Textarea rows={5} autoFocus value={pinEdit} onChange={(e) => setPinEdit(e.target.value)} placeholder="- Staging URL: https://staging.example.com&#10;- Design doc: https://…" />
              <div className="pj-save">
                <Button size="sm" variant="primary" onClick={savePinned}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPinEdit(null)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="pj-pinned" role="button" tabIndex={0} onClick={() => setPinEdit(index?.pinned || '')}>
              <span className="muted small">Pinned</span>
              {index?.pinned ? <Md text={index.pinned} /> : <span className="muted small">Nothing pinned. Click to add.</span>}
            </div>
          )}
        </Card>
        <div className="pj-overview-bar">
          <span className="pj-mem-sec">Files</span>
          <span className="spacer" />
          <Button size="sm" onClick={() => setOpen({ name: '', description: '', type: null, content: '', isNew: true, editing: true })}>
            ＋ New file
          </Button>
        </div>
        {!files && <Spinner />}
        {files?.length === 0 && <div className="muted pad">No memory yet. Ask Claude below, or a thread, to remember something, or add a file.</div>}
        {files?.map((f) => (
          <Card key={f.name} interactive className="pj-memrow" onClick={() => openFile(f.name)}>
            <span className="pj-thread-title">{f.name}</span>
            <span className="muted small pj-memdesc">{f.description}</span>
            <span className="muted small">
              {kb(f.size)} · updated {timeAgo(Date.parse(f.modified))}
            </span>
          </Card>
        ))}
        <div className="pj-memask">
          <Textarea rows={2} value={ask} onChange={(e) => (setAsk(e.target.value), setAsked(false))} placeholder="Ask Claude to change memory, e.g. merge the two deploy files" />
          <Button size="sm" onClick={sendAsk} disabled={!ask.trim()}>
            Ask
          </Button>
        </div>
        {asked && <div className="muted small">Sent to the project chat; the coordinator will make the change.</div>}
      </div>
    </div>
  );
}

/** Library: shared files, uploads and thread outputs. Every session gets the folder. */
export function ProjectLibrary({ project, onError }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const load = () =>
    api(`/api/cprojects/${project.id}/library`)
      .then(setData)
      .catch(onError);
  useEffect(() => {
    load();
  }, [project.id, project.lastActivity]); // eslint-disable-line react-hooks/exhaustive-deps
  const upload = async (list) => {
    setBusy(true);
    for (const f of list) {
      if (f.size > 25 << 20) {
        onError(new Error(`${f.name} is over 25 MB`));
        continue;
      }
      const data64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] || '');
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      await api(`/api/cprojects/${project.id}/library`, { method: 'POST', body: { name: f.name, data: data64 } }).catch(onError);
    }
    setBusy(false);
    load();
  };
  const del = async (p) => {
    if (!(await confirmDialog(`Delete ${p} from the library?`, { title: 'Delete file', ok: 'Delete', danger: true }))) return;
    await api(`/api/cprojects/${project.id}/library/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' }).catch(onError);
    load();
  };
  return (
    <div
      className="pj-overview"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) upload([...e.dataTransfer.files]);
      }}
    >
      <div className="pj-overview-inner">
        <div className="pj-overview-bar">
          <span className="muted">Files every session in the project can read. Threads put deliverables here; drop files to upload.</span>
          <Button size="sm" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : '↑ Upload'}
          </Button>
          <input ref={input} type="file" multiple hidden onChange={(e) => (upload([...e.target.files]), (e.target.value = ''))} />
        </div>
        {data && <div className="muted small mono">{data.root}</div>}
        {!data && <Spinner />}
        {data?.files.length === 0 && <div className="muted pad">The library is empty.</div>}
        {data?.files.map((f) => (
          <Card key={f.path} className="pj-memrow">
            <a className="pj-thread-title" href={`/api/cprojects/${project.id}/library/file?path=${encodeURIComponent(f.path)}`} download>
              {f.path}
            </a>
            <span className="muted small">
              {kb(f.size)} · {timeAgo(f.modified)}
            </span>
            <Button size="sm" variant="ghost" onClick={() => del(f.path)}>
              Delete
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
