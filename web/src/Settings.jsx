import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { getThemePref, setThemePref } from './theme.js';
import { getPrefs, setPref } from './prefs.js';
import { MODES } from './chat/Composer.jsx';
import { useModels } from './models.js';
import { McpTab, PluginsTab, SkillsTab } from './Customize.jsx';
import DesktopTab from './DesktopTab.jsx';
import { Button, IconButton, Modal, ModalHead, Segmented, Toggle } from './ui/index.jsx';

const TABS = [
  ['general', 'General'],
  ['chats', 'New chats'],
  ['permissions', 'Permissions'],
  ['mcp', 'MCP servers'],
  ['plugins', 'Plugins'],
  ['skills', 'Skills'],
  ['desktop', 'Claude Desktop'],
  ['account', 'Account'],
  ['about', 'About'],
];

function Row({ label, desc, children }) {
  return (
    <div className="set-row">
      <div className="set-label">
        {label}
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="set-ctl fields sm">{children}</div>
    </div>
  );
}

function General({ prefs, set, onKeys }) {
  const [theme, setTheme] = useState(getThemePref);
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  return (
    <>
      <Row label="Theme">
        <Segmented
          value={theme}
          options={[
            ['system', 'System'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ]}
          onChange={(t) => (setThemePref(t), setTheme(t))}
        />
      </Row>
      <Row label="Chat text size">
        <Segmented
          value={prefs.fontSize}
          options={[
            ['small', 'S'],
            ['medium', 'M'],
            ['large', 'L'],
            ['xlarge', 'XL'],
          ]}
          onChange={(v) => set('fontSize', v)}
        />
      </Row>
      <Row label="Enter sends the message" desc="When off, use Ctrl+Enter to send. On phones the send button is always used.">
        <Toggle value={prefs.sendOnEnter} onChange={(v) => set('sendOnEnter', v)} />
      </Row>
      <Row label="Desktop notifications" desc={perm === 'denied' ? 'Blocked in this browser. Allow them in the site settings.' : 'Notify when Claude finishes or needs approval while this tab is in the background.'}>
        {perm === 'default' ? (
          <Button size="sm" onClick={() => Notification.requestPermission().then(setPerm)}>
            Allow
          </Button>
        ) : (
          <Toggle value={prefs.notifications && perm === 'granted'} onChange={(v) => set('notifications', v)} />
        )}
      </Row>
      <Row label="Keyboard shortcuts">
        <Button size="sm" onClick={onKeys}>
          Show
        </Button>
      </Row>
    </>
  );
}

function Chats({ prefs, set }) {
  const models = useModels();
  const list = models.length ? models : [{ id: '', displayName: 'Default' }];
  return (
    <>
      <p className="muted set-note">Used for each new chat. You can still change them from the composer.</p>
      <Row label="Model">
        <select value={prefs.newModel} onChange={(e) => set('newModel', e.target.value)}>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
          {prefs.newModel && !list.some((m) => m.id === prefs.newModel) && <option value={prefs.newModel}>{prefs.newModel}</option>}
        </select>
      </Row>
      <Row label="Permission mode">
        <select value={prefs.newMode} onChange={(e) => set('newMode', e.target.value)}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Effort">
        <select value={prefs.newEffort} onChange={(e) => set('newEffort', e.target.value)}>
          <option value="">Default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">Extra high</option>
          <option value="max">Max</option>
        </select>
      </Row>
    </>
  );
}

function Permissions({ projects, activeCwd, onError }) {
  const [cwd, setCwd] = useState(activeCwd || '');
  const [rules, setRules] = useState(null);
  const load = () =>
    api(`/api/claude/permissions${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)
      .then((r) => setRules(r.rules))
      .catch((e) => (setRules([]), onError(e)));
  useEffect(() => {
    setRules(null);
    load();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = (r) =>
    api('/api/claude/permissions/remove', { method: 'POST', body: { cwd, scope: r.scope, behavior: r.behavior, rule: r.rule } })
      .then(load)
      .catch(onError);
  const options = [...new Set([activeCwd, ...projects.projects.map((p) => p.path)].filter(Boolean))];
  return (
    <>
      <p className="muted set-note">Rules saved with "Always allow" and rules from your Claude Code settings files. Removing one takes effect in new chats.</p>
      <Row label="Folder">
        <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
          <option value="">User settings only</option>
          {options.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Row>
      {!rules && <div className="muted">Loading…</div>}
      {rules?.length === 0 && <div className="muted">No saved rules.</div>}
      {rules?.length > 0 && (
        <div className="rule-list">
          {rules.map((r, i) => (
            <div key={i} className="rule card">
              <span className={`pill rbadge ${r.behavior === 'allow' ? 'green' : r.behavior === 'deny' ? 'red' : ''}`}>{r.behavior === 'defaultMode' ? 'mode' : r.behavior}</span>
              <code title={r.file}>{r.rule}</code>
              <span className="muted rscope">{r.scope}</span>
              {r.behavior !== 'defaultMode' && (
                <IconButton title="Remove" onClick={() => remove(r)}>
                  ✕
                </IconButton>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function TextTab({ url, note }) {
  const [data, setData] = useState(null);
  const load = () => {
    setData(null);
    api(url)
      .then(setData)
      .catch((e) => setData({ text: e.message }));
  };
  useEffect(load, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <p className="muted set-note">
        {note}{' '}
        <button className="link-btn" onClick={load}>
          Refresh
        </button>
      </p>
      <pre className="set-pre">{data ? data.text || 'Nothing configured.' : 'Checking… (this can take a few seconds)'}</pre>
    </>
  );
}

function Account() {
  const [s, setS] = useState(null);
  useEffect(() => {
    api('/api/claude/status')
      .then(setS)
      .catch((e) => setS({ error: e.message }));
  }, []);
  if (!s) return <div className="muted">Checking…</div>;
  if (s.error) return <div className="muted">{s.error}</div>;
  const a = s.auth || {};
  const fields = Object.entries(a).filter(([, v]) => v != null && typeof v !== 'object');
  return (
    <>
      <p className="muted set-note">The Claude Code login on the server. Use "Log in again" in a chat's menu to change it.</p>
      {a.raw ? (
        <pre className="set-pre">{a.raw}</pre>
      ) : (
        <div className="kv">
          {fields.map(([k, v]) => (
            <React.Fragment key={k}>
              <span className="k">{k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</span>
              <span className="v">{String(v)}</span>
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
}

function About() {
  const [s, setS] = useState(null);
  useEffect(() => {
    api('/api/claude/status')
      .then(setS)
      .catch(() => setS({}));
  }, []);
  return (
    <div className="kv">
      <span className="k">Claude Code</span>
      <span className="v">{s?.version || '…'}</span>
      <span className="k">Server</span>
      <span className="v">
        {s ? `Node ${s.node} on ${s.platform}` : '…'}
      </span>
      <span className="k">Folders root</span>
      <span className="v">{s?.projectsRoot || '…'}</span>
      <span className="k">Data folder</span>
      <span className="v">{s?.dataDir || '…'}</span>
    </div>
  );
}

export default function Settings({ projects, activeCwd, onClose, onError, onKeys, initialTab }) {
  const [tab, setTab] = useState(initialTab || 'general');
  const [prefs, setPrefs] = useState(getPrefs);
  const set = (k, v) => setPrefs(setPref(k, v));
  return (
    <Modal onClose={onClose} size="wide" className="settings">
      <nav className="set-nav">
        <div className="set-title">Settings</div>
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="set-main">
        <ModalHead title={TABS.find((t) => t[0] === tab)[1]} onClose={onClose} />
        <div className="modal-body">
          {tab === 'general' && <General prefs={prefs} set={set} onKeys={onKeys} />}
          {tab === 'chats' && <Chats prefs={prefs} set={set} />}
          {tab === 'permissions' && <Permissions projects={projects} activeCwd={activeCwd} onError={onError} />}
          {tab === 'mcp' && <McpTab projects={projects} activeCwd={activeCwd} onError={onError} />}
          {tab === 'plugins' && <PluginsTab onError={onError} />}
          {tab === 'skills' && <SkillsTab projects={projects} activeCwd={activeCwd} onError={onError} />}
          {tab === 'desktop' && <DesktopTab onError={onError} projects={projects} activeCwd={activeCwd} />}
          {tab === 'account' && <Account />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </Modal>
  );
}

const KEYS = [
  ['Ctrl/⌘ K', 'Search chats, files and actions'],
  ['Ctrl/⌘ B', 'Show or hide the sidebar'],
  ['Ctrl/⌘ ,', 'Settings'],
  ['Ctrl/⌘ /', 'Keyboard shortcuts'],
  ['Enter', 'Send (Shift+Enter for a new line)'],
  ['Shift Tab', 'Cycle permission mode'],
  ['Esc', 'Stop Claude while it works'],
  ['Alt ↑ ↓', 'Previous or next chat'],
  ['Ctrl O', 'Normal or verbose view'],
  ['Ctrl `', 'Terminal'],
  ['Ctrl/⌘ Shift D', 'Changes and diff'],
  ['Ctrl/⌘ Shift B', 'Browser'],
  ['Ctrl/⌘ Shift M', 'Permission mode menu'],
  ['Ctrl/⌘ Shift E', 'Effort menu'],
  ['!', 'Run a shell command at the start of a message'],
  ['/', 'Slash commands at the start of a message'],
  ['@', 'Mention a file'],
  ['↑ ↓ Tab', 'Move through and pick a suggestion'],
];

export function Shortcuts({ onClose }) {
  return (
    <Modal onClose={onClose}>
      <ModalHead title="Keyboard shortcuts" onClose={onClose} />
      <div className="modal-body">
        <div className="kv keys">
          {KEYS.map(([k, d]) => (
            <React.Fragment key={k}>
              <span className="k">
                {k.split(' ').map((p) => (
                  <kbd key={p}>{p}</kbd>
                ))}
              </span>
              <span className="v">{d}</span>
            </React.Fragment>
          ))}
        </div>
      </div>
    </Modal>
  );
}
