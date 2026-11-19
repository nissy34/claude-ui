import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useModels } from '../models.js';
import { Button, Checkbox, Input, Modal, ModalBody, ModalFoot, ModalHead, Segmented, Select, Textarea } from '../ui/index.jsx';
import { confirmDialog } from '../ui/dialogs.jsx';

const EFFORTS = [
  ['', 'Default'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
];
const MODES = [
  ['auto', 'Auto (fewest prompts)'],
  ['acceptEdits', 'Accept edits'],
  ['default', 'Ask before edits'],
  ['plan', 'Plan only'],
];

export function ModelPicker({ label, hint, value, onChange }) {
  const models = useModels();
  const opts = models.length ? models.map((m) => [m.id, m.displayName || m.id || 'Default']) : [['', 'Default'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];
  if (value.model && !opts.some(([v]) => v === value.model)) opts.push([value.model, value.model]);
  return (
    <div className="pj-model">
      <div className="pj-model-label">
        {label}
        {hint && <span className="muted small"> · {hint}</span>}
      </div>
      <div className="pj-model-row">
        <Select value={value.model || ''} onChange={(e) => onChange({ ...value, model: e.target.value })}>
          {opts.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <Select value={value.effort || ''} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
          {EFFORTS.map(([v, l]) => (
            <option key={v} value={v}>
              {l} effort
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function FolderPicker({ folders, onChange, projects }) {
  const list = projects?.projects || [];
  return (
    <div className="pj-folders">
      {folders.map((f, i) => (
        <div key={i} className="pj-folder-row">
          <Input mono list="pj-folder-list" value={f.path} placeholder="Folder (name in your projects root, or a full path)" onChange={(e) => onChange(folders.map((x, j) => (j === i ? { path: e.target.value } : x)))} />
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(folders.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <datalist id="pj-folder-list">
        {list.map((p) => (
          <option key={p.path} value={p.path}>
            {p.name}
          </option>
        ))}
      </datalist>
      <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...folders, { path: '' }])}>
        ＋ Add folder
      </Button>
      <div className="muted small">The first folder is where threads work. When it is a git repository each thread gets its own worktree and branch; other folders are added read-mostly.</div>
    </div>
  );
}

/** The editable part shared by New project and Project settings. */
function SettingsFields({ s, set, projects, full }) {
  const p = s.policy;
  const setP = (patch) => set({ ...s, policy: { ...p, ...patch } });
  return (
    <>
      <label>
        Name
        <Input value={s.name} onChange={(e) => set({ ...s, name: e.target.value })} placeholder="e.g. Checkout redesign" autoFocus={!full} />
      </label>
      <label>
        Goal <span className="muted small">(one line, optional)</span>
        <Input value={s.goal} onChange={(e) => set({ ...s, goal: e.target.value })} placeholder="What this project is for" />
      </label>
      <div className="pj-field">
        <div className="pj-model-label">Folders</div>
        <FolderPicker folders={s.folders} onChange={(folders) => set({ ...s, folders })} projects={projects} />
      </div>
      <div className="pj-field">
        <div className="pj-model-label">Models</div>
        <ModelPicker label="Coordinator" hint="routes work, short turns" value={s.models.coordinator} onChange={(v) => set({ ...s, models: { ...s.models, coordinator: v } })} />
        <ModelPicker label="Threads" hint="do the work" value={s.models.thread} onChange={(v) => set({ ...s, models: { ...s.models, thread: v } })} />
      </div>
      <div className="pj-grid">
        <label>
          Threads running at once
          <Input type="number" min={1} max={20} value={p.maxRunning} onChange={(e) => setP({ maxRunning: e.target.value })} />
        </label>
        <label>
          Thread permission mode
          <Select value={p.threadPermissionMode} onChange={(e) => setP({ threadPermissionMode: e.target.value })}>
            {MODES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="pj-field">
        <div className="pj-model-label">Updates</div>
        <Segmented
          value={p.proactivity}
          onChange={(v) => setP({ proactivity: v })}
          options={[
            ['quiet', 'Quiet'],
            ['normal', 'Normal'],
            ['chatty', 'Chatty'],
          ]}
        />
        <div className="muted small">
          {p.proactivity === 'quiet' ? 'The coordinator wakes only for your messages, blockers, questions and errors.' : p.proactivity === 'normal' ? 'Also when threads finish.' : `Also a check-in every ${p.checkInMinutes} minutes when threads changed.`}
        </div>
      </div>
      <label>
        Instructions <span className="muted small">(standing rules for every session, up to 16,000 characters)</span>
        <Textarea rows={full ? 6 : 3} value={s.instructions} onChange={(e) => set({ ...s, instructions: e.target.value })} placeholder="e.g. Open a draft PR for every change. Never touch the payments module." />
      </label>
      {full && (
        <details className="pj-advanced">
          <summary>Advanced</summary>
          <Checkbox checked={p.worktrees} onChange={(v) => setP({ worktrees: v })}>
            Give each thread its own git worktree
          </Checkbox>
          <div className="pj-grid">
            <label>
              Check-in every (minutes, Chatty)
              <Input type="number" min={5} value={p.checkInMinutes} onChange={(e) => setP({ checkInMinutes: e.target.value })} />
            </label>
            <label>
              Reset coordinator context after (tokens)
              <Input type="number" min={20000} step={10000} value={p.rotateTokens} onChange={(e) => setP({ rotateTokens: e.target.value })} />
            </label>
          </div>
          <div className="pj-grid">
            <label>
              Quiet hours from
              <Input type="time" value={p.quietHours?.from || ''} onChange={(e) => setP({ quietHours: e.target.value ? { from: e.target.value, to: p.quietHours?.to || '07:00' } : null })} />
            </label>
            <label>
              to
              <Input type="time" value={p.quietHours?.to || ''} onChange={(e) => setP({ quietHours: p.quietHours ? { ...p.quietHours, to: e.target.value } : null })} />
            </label>
          </div>
          <label>
            Always ask before <span className="muted small">(permission rules for threads, one per line; these prompt you even in Auto mode)</span>
            <Textarea mono rows={4} value={(p.askRules || []).join('\n')} onChange={(e) => setP({ askRules: e.target.value.split('\n') })} />
          </label>
        </details>
      )}
    </>
  );
}

const DEFAULTS = {
  name: '',
  goal: '',
  instructions: '',
  folders: [{ path: '' }],
  models: { coordinator: { model: 'sonnet', effort: 'low' }, thread: { model: 'opus', effort: 'high' } },
  policy: { maxRunning: 3, proactivity: 'normal', threadPermissionMode: 'auto', worktrees: true, checkInMinutes: 30, rotateTokens: 60000, quietHours: null, askRules: [] },
};

const clean = (s) => ({ ...s, folders: s.folders.filter((f) => f.path.trim()), policy: { ...s.policy, askRules: (s.policy.askRules || []).map((r) => r.trim()).filter(Boolean) } });

export function NewProjectDialog({ onClose, onCreated, onError, projects, defaultFolder }) {
  const [s, set] = useState(() => ({ ...DEFAULTS, folders: [{ path: defaultFolder || '' }] }));
  const [first, setFirst] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { project } = await api('/api/cprojects', { method: 'POST', body: { ...clean(s), prompt: first } });
      onCreated(project);
    } catch (err) {
      onError(err);
    }
    setBusy(false);
  };
  return (
    <Modal as="form" size="wide" onSubmit={submit} onClose={onClose}>
      <ModalHead title="New project" onClose={onClose} />
      <ModalBody className="fields pj-form">
        <SettingsFields s={s} set={set} projects={projects} />
        <label>
          First message <span className="muted small">(optional)</span>
          <Textarea rows={3} value={first} onChange={(e) => setFirst(e.target.value)} placeholder="What should happen first?" />
        </label>
      </ModalBody>
      <ModalFoot>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!s.name.trim() || busy}>
          Create project
        </Button>
      </ModalFoot>
    </Modal>
  );
}

export default function ProjectSettings({ project, onSelect, onError, reload, onDeleted, projects }) {
  const [s, set] = useState(() => ({ ...project.settings, folders: project.settings.folders.length ? project.settings.folders : [{ path: '' }] }));
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [s]);
  const save = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/cprojects/${project.id}`, { method: 'PATCH', body: clean(s) });
      setSaved(true);
      reload();
    } catch (err) {
      onError(err);
    }
  };
  const del = async () => {
    if (!(await confirmDialog(`Delete "${project.name}"? Its threads stay as archived chats; the project chat, memory and library are deleted.`, { title: 'Delete project', ok: 'Delete', danger: true }))) return;
    try {
      await api(`/api/cprojects/${project.id}`, { method: 'DELETE' });
      onDeleted?.();
    } catch (err) {
      onError(err);
    }
  };
  const byCost = [...project.threads].sort((a, b) => b.cost - a.cost);
  return (
    <div className="pj-overview">
      <form className="pj-overview-inner fields pj-form" onSubmit={save}>
        <SettingsFields s={s} set={set} projects={projects} full />
        <div className="pj-save">
          <Button variant="primary">Save</Button>
          {saved && <span className="muted small">Saved. Model changes apply to the coordinator now and to threads started from now on.</span>}
        </div>
        <div className="pj-field">
          <div className="pj-model-label">Usage</div>
          <div className="pj-usage">
            <div>
              Total <b>${project.usage.total.toFixed(2)}</b> · coordinator ${project.usage.coordinator.toFixed(2)}
              {project.coordinator && <> · coordinator context {Math.round(project.coordinator.contextTokens / 1000)}k tokens</>}
            </div>
            {byCost.slice(0, 12).map((t) => (
              <div key={t.id} className="pj-usage-row">
                <button type="button" className="linklike" onClick={() => onSelect(t.id)}>
                  {t.title}
                </button>
                <span className="muted">${t.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="pj-field pj-danger">
          <Button type="button" variant="ghost" onClick={() => onSelect(project.coordinatorId)}>
            Open the coordinator's work log
          </Button>
          <Button type="button" variant="danger" onClick={del}>
            Delete project
          </Button>
        </div>
      </form>
    </div>
  );
}
