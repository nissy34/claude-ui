import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useModels } from '../models.js';
import { Button, Checkbox, Input, Modal, ModalBody, ModalFoot, ModalHead, Segmented, Select, Textarea, Toggle } from '../ui/index.jsx';
import { ProjectMemory } from './ProjectFiles.jsx';
import { confirmDialog } from '../ui/dialogs.jsx';
import { fmtTok } from './ProjectUsage.jsx';
import { fmtReset, windowName } from '../chat/Composer.jsx';
import { ProjectIcon } from './ProjectView.jsx';

const PROJECT_COLORS = ['orange', 'blue', 'green', 'purple', 'pink', 'teal', 'yellow', 'red'];

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
      {label && (
        <div className="pj-model-label">
          {label}
          {hint && <span className="muted small"> · {hint}</span>}
        </div>
      )}
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
          <Input mono list="pj-folder-list" value={f.path} placeholder="Folder (name in your folders root, or a full path)" onChange={(e) => onChange(folders.map((x, j) => (j === i ? { path: e.target.value } : x)))} />
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
  policy: { proactivity: 'normal', threadPermissionMode: 'auto', worktrees: true, checkInMinutes: 30, quietHours: null, askRules: [] },
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

const SECTIONS = [
  ['general', '⚙', 'General'],
  ['memory', '◇', 'Memory'],
  ['environment', '☁', 'Environment'],
  ['usage', '↗', 'Usage'],
  ['advanced', '⚒', 'Advanced'],
];

function Row({ label, hint, children, stack }) {
  return (
    <div className={`pjs-row ${stack ? 'stack' : ''}`}>
      <div className="pjs-label">
        {label}
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="pjs-control">{children}</div>
    </div>
  );
}

/** Project settings, in a window with sections (General, Memory, Environment, Usage, Advanced). */
export function ProjectSettingsModal({ project, section, setSection, onClose, onSelect, onError, reload, onDeleted, projects }) {
  const [s, set] = useState(() => ({ ...project.settings, folders: project.settings.folders.length ? project.settings.folders : [{ path: '' }] }));
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [s, section]);
  const p = s.policy;
  const setP = (patch) => set({ ...s, policy: { ...p, ...patch } });
  const save = async (patch) => {
    try {
      await api(`/api/cprojects/${project.id}`, { method: 'PATCH', body: patch || clean(s) });
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
  const archive = async () => {
    await save({ archived: !project.archived });
    if (!project.archived) onClose();
  };
  const byCost = [...project.threads].sort((a, b) => b.cost - a.cost);
  const done = project.threads.filter((t) => t.status === 'resolved').length;
  const prs = project.threads.filter((t) => t.pr?.url);
  const added = prs.reduce((n, t) => n + (t.pr.additions || 0), 0);
  const removed = prs.reduce((n, t) => n + (t.pr.deletions || 0), 0);
  const total = project.usage.total || 0;
  const share = (c) => (total > 0 ? `${Math.round((c / total) * 100)}%` : '');
  const post = (what) => api(`/api/cprojects/${project.id}/${what}`, { method: 'POST' }).then(reload).catch(onError);
  // Only tabs with editable fields (General, Environment, Advanced) render this.
  const SaveBar = ({ note }) => (
    <div className="pjs-save">
      {saved && <span className="muted small">Saved.{note ? ` ${note}` : ''}</span>}
      <Button variant="primary" onClick={() => save()}>
        Save
      </Button>
    </div>
  );
  return (
    <Modal size="wide" className="pjs" onClose={onClose}>
      <ModalHead title="Project settings" onClose={onClose} />
      <div className="pjs-wrap">
        <nav className="pjs-nav">
          {SECTIONS.map(([k, icon, label]) => (
            <button key={k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>
              <span className="pjs-ico">{icon}</span> {label}
            </button>
          ))}
        </nav>
        <div className="pjs-main">
          {section === 'general' && (
            <>
              <h3>General</h3>
              <Row label="Name">
                <Input value={s.name} onChange={(e) => set({ ...s, name: e.target.value })} />
              </Row>
              <Row label="Icon" hint="An emoji or up to 2 letters; empty uses the first letter">
                <div className="pj-swatches">
                  <ProjectIcon project={{ name: s.name || project.name, icon: s.icon, color: s.color || project.color }} size="md" />
                  <Input className="pj-icon-input" value={s.icon || ''} maxLength={8} placeholder={(s.name || project.name).trim()[0]?.toUpperCase()} onChange={(e) => set({ ...s, icon: e.target.value })} />
                  {PROJECT_COLORS.map((c) => (
                    <button key={c} type="button" title={c} aria-label={`Color ${c}`} className={`pj-swatch pj-ic c-${c} ${(s.color || project.color) === c ? 'on' : ''}`} onClick={() => set({ ...s, color: c })} />
                  ))}
                </div>
              </Row>
              <Row label="What do you want to work on?" stack>
                <Textarea rows={4} maxLength={8000} value={s.goal} onChange={(e) => set({ ...s, goal: e.target.value })} placeholder="Redesign onboarding so more new users finish setup" />
                <div className="muted small pjs-count">{(s.goal || '').length} / 8,000</div>
              </Row>
              <h4>Models</h4>
              <Row label="Coordinator" hint="Routes work; short turns. Also switchable from the project chat box">
                <ModelPicker label="" value={s.models.coordinator} onChange={(v) => set({ ...s, models: { ...s.models, coordinator: v } })} />
              </Row>
              <Row label="New threads" hint="The default for threads started from now on. Switch a running thread from its own box">
                <ModelPicker label="" value={s.models.thread} onChange={(v) => set({ ...s, models: { ...s.models, thread: v } })} />
              </Row>
              <hr />
              <Row label="Continue threads automatically when usage limits reset">
                <Toggle value={p.continueOnReset !== false} onChange={(v) => setP({ continueOnReset: v })} label="Continue on reset" />
              </Row>
              <SaveBar note="Model changes apply to the coordinator now and to threads started from now on." />
              <Row label="Archive project" hint="Hidden from the sidebar; nothing is deleted">
                <Button onClick={archive}>{project.archived ? 'Unarchive' : 'Archive'}</Button>
              </Row>
              <h4>Danger zone</h4>
              <Row label="Delete project" hint="Its threads stay as archived chats; the project chat, memory and files are deleted. This can't be undone.">
                <Button variant="danger" onClick={del}>
                  Delete
                </Button>
              </Row>
            </>
          )}
          {section === 'memory' && (
            <>
              <h3>Memory</h3>
              <ProjectMemory project={project} onError={onError} />
            </>
          )}
          {section === 'environment' && (
            <>
              <h3>Environment</h3>
              <Row label="Folders" stack>
                <FolderPicker folders={s.folders} onChange={(folders) => set({ ...s, folders })} projects={projects} />
              </Row>
              <Row label="Give each thread its own git worktree">
                <Toggle value={p.worktrees} onChange={(v) => setP({ worktrees: v })} label="Worktrees" />
              </Row>
              <Row label="Thread permission mode">
                <Select value={p.threadPermissionMode} onChange={(e) => setP({ threadPermissionMode: e.target.value })}>
                  {MODES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row label="Always ask before" hint="Permission rules for threads, one per line; these prompt you even in Auto mode" stack>
                <Textarea mono rows={5} value={(p.askRules || []).join('\n')} onChange={(e) => setP({ askRules: e.target.value.split('\n') })} />
              </Row>
              <SaveBar />
            </>
          )}
          {section === 'usage' && (
            <>
              <h3>Usage</h3>
              <div className="pj-activity-stats">
                <div>
                  <b>{done}</b>
                  <span className="muted small">Threads done</span>
                </div>
                <div>
                  <b>{prs.length}</b>
                  <span className="muted small">Pull requests</span>
                </div>
                <div>
                  <b>
                    <span className="add">+{added}</span> <span className="del">−{removed}</span>
                  </b>
                  <span className="muted small">Code changes</span>
                </div>
              </div>
              <Row label="Total">
                <b>${project.usage.total.toFixed(2)}</b>
                {project.usage.tokens > 0 && <span className="muted small"> · {fmtTok(project.usage.tokens)} tokens</span>}
                <span className="muted small"> · coordinator ${project.usage.coordinator.toFixed(2)}{project.coordinator ? ` · context ${Math.round(project.coordinator.contextTokens / 1000)}k tokens` : ''}</span>
              </Row>
              {Object.keys(project.rateLimit || {}).length > 0 && (
                <>
                  <h4>Plan usage limits</h4>
                  <div className="pj-usage">
                    {Object.entries(project.rateLimit).map(([k, w]) => (
                      <div key={k}>
                        <div className="pj-usage-row">
                          <span>{windowName(k)}</span>
                          <span className="muted">
                            {fmtReset(w.resetsAt)} · {Math.round((w.utilization || 0) * 100)}%
                          </span>
                        </div>
                        <div className="meter">
                          <span style={{ width: `${Math.min(100, (w.utilization || 0) * 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <h4>By thread</h4>
              <div className="pj-usage">
                {byCost.length === 0 && <div className="muted small">No threads yet.</div>}
                {byCost.map((t) => (
                  <div key={t.id} className="pj-usage-row">
                    <button type="button" className="linklike" onClick={() => (onClose(), onSelect(t.id))}>
                      {t.title}
                    </button>
                    <span className="spacer" />
                    {t.tokens > 0 && <span className="muted tokens">{fmtTok(t.tokens)}</span>}
                    <span className="muted">${t.cost.toFixed(2)}</span>
                    <span className="muted share">{share(t.cost)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {section === 'advanced' && (
            <>
              <h3>Advanced</h3>
              <Row label="Updates" hint={p.proactivity === 'quiet' ? 'The coordinator wakes only for your messages, blockers, questions and errors.' : p.proactivity === 'normal' ? 'Also when threads finish.' : `Also a check-in every ${p.checkInMinutes} minutes when threads changed.`}>
                <Segmented value={p.proactivity} onChange={(v) => setP({ proactivity: v })} options={[['quiet', 'Quiet'], ['normal', 'Normal'], ['chatty', 'Chatty']]} />
              </Row>
              <Row label="Check-in every (minutes, Chatty)">
                <Input type="number" min={5} value={p.checkInMinutes} onChange={(e) => setP({ checkInMinutes: e.target.value })} />
              </Row>
              <Row label="Quiet hours">
                <div className="pjs-inline">
                  <Input type="time" value={p.quietHours?.from || ''} onChange={(e) => setP({ quietHours: e.target.value ? { from: e.target.value, to: p.quietHours?.to || '07:00' } : null })} />
                  <span className="muted">to</span>
                  <Input type="time" value={p.quietHours?.to || ''} onChange={(e) => setP({ quietHours: p.quietHours ? { ...p.quietHours, to: e.target.value } : null })} />
                </div>
              </Row>
              <SaveBar />
              <Row label={project.paused ? 'Resume project' : 'Pause project'} hint={project.paused ? 'Threads and the coordinator pick up their queued messages.' : 'Take a break or save usage. Nothing new starts until you resume; running turns finish.'}>
                <Button onClick={() => post(project.paused ? 'resume' : 'pause')}>{project.paused ? 'Resume' : 'Pause'}</Button>
              </Row>
              <Row label="Restart the coordinator" hint="Try this if Claude stops responding in the project chat. A reply in progress is interrupted; it starts over from a digest of the project.">
                <Button onClick={() => post('restart-coordinator')}>Restart</Button>
              </Row>
              <Row label="Coordinator work log" hint="Everything the coordinator did, tool by tool">
                <Button onClick={() => (onClose(), onSelect(project.coordinatorId))}>Open</Button>
              </Row>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
