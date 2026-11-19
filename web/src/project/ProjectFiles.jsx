import React, { useEffect, useRef, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { Button, Card, Input, Spinner, Textarea } from '../ui/index.jsx';
import { confirmDialog } from '../ui/dialogs.jsx';
import { Md } from './ProjectCards.jsx';

const kb = (n) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

/** Project memory: notes every session in the project shares, one file per subject. */
export function ProjectMemory({ project, onError, initial }) {
  const [files, setFiles] = useState(null);
  const [open, setOpen] = useState(null); // { name, description, content, version, isNew, editing }
  useEffect(() => {
    if (initial)
      api(`/api/cprojects/${project.id}/memory/${encodeURIComponent(initial)}`)
        .then((r) => setOpen({ ...r, editing: false }))
        .catch(onError);
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = () =>
    api(`/api/cprojects/${project.id}/memory`)
      .then((r) => setFiles(r.files))
      .catch(onError);
  useEffect(() => {
    load();
  }, [project.id, project.lastActivity]); // eslint-disable-line react-hooks/exhaustive-deps
  const openFile = (name) =>
    api(`/api/cprojects/${project.id}/memory/${encodeURIComponent(name)}`)
      .then((r) => setOpen({ ...r, editing: false }))
      .catch(onError);
  const save = async () => {
    try {
      const r = await api(`/api/cprojects/${project.id}/memory/${encodeURIComponent(open.name)}`, { method: 'PUT', body: { description: open.description, content: open.content, version: open.isNew ? undefined : open.version } });
      setOpen({ ...open, name: r.name, version: r.version, isNew: false, editing: false });
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
                Description <span className="muted small">(one line, shown in the index every session sees)</span>
                <Input value={open.description} onChange={(e) => setOpen({ ...open, description: e.target.value })} />
              </label>
              <label>
                Content <span className="muted small">(Markdown, under 4 KB)</span>
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
            <Card className="pj-memfile">
              <div className="pj-thread-title">{open.name}</div>
              <div className="muted small">{open.description}</div>
              <Md text={open.content} />
            </Card>
          )}
        </div>
      </div>
    );
  return (
    <div className="pj-overview">
      <div className="pj-overview-inner">
        <div className="pj-overview-bar">
          <span className="muted">Notes every session in this project reads: requirements, decisions, pitfalls. Claude keeps them; you can edit them too.</span>
          <Button size="sm" onClick={() => setOpen({ name: '', description: '', content: '', isNew: true, editing: true })}>
            ＋ New file
          </Button>
        </div>
        {!files && <Spinner />}
        {files?.length === 0 && <div className="muted pad">No memory yet. Ask the coordinator or a thread to remember something, or add a file.</div>}
        {files?.map((f) => (
          <Card key={f.name} interactive className="pj-memrow" onClick={() => openFile(f.name)}>
            <span className="pj-thread-title">{f.name}</span>
            <span className="muted small pj-memdesc">{f.description}</span>
            <span className="muted small">
              {kb(f.size)} · {timeAgo(Date.parse(f.modified))}
            </span>
          </Card>
        ))}
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
