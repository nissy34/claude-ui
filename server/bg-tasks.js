// Background tasks of a chat: shells Claude started with run_in_background, Monitor watches,
// background subagents, workflows and MCP tasks. Claude Code reports them on the stream-json
// channel (system task_started / task_progress / task_updated / task_notification and the
// background_tasks_changed level signal) and takes control requests to read a shell's output
// (get_task_output) and to stop one (stop_task). Mixed into ChatSession.
import fs from 'node:fs';

const KEEP_ENDED = 20; // finished tasks kept in the list so their output can still be read
const TAIL_BYTES = 8192;
const ENDED = new Set(['completed', 'failed', 'stopped', 'killed']);

const KIND = { local_bash: 'shell', monitor: 'monitor', local_agent: 'agent', remote_agent: 'agent', local_workflow: 'workflow', mcp_task: 'mcp' };

export function isTaskMessage(msg) {
  return msg.type === 'system' && /^(task_started|task_progress|task_updated|task_notification|background_tasks_changed)$/.test(msg.subtype || '');
}

export const bgTaskMethods = {
  // A method, not a getter: Object.assign onto the prototype would call a getter once and share
  // its Map between every chat.
  taskMap() {
    return (this._bgTasks ||= new Map());
  },

  /** What the UI shows: background tasks only (a foreground Bash call is just its tool card). */
  tasksSummary() {
    const out = [];
    for (const t of this.taskMap().values()) {
      if (!t.background || t.ambient) continue;
      out.push({
        id: t.id,
        kind: t.kind,
        type: t.type,
        description: t.description,
        command: t.command,
        agentType: t.agentType,
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        summary: t.summary,
        lastTool: t.lastTool,
        usage: t.usage,
        error: t.error,
        toolUseId: t.toolUseId,
        canOutput: t.kind === 'shell' || t.kind === 'monitor',
      });
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  },

  liveTaskCount() {
    let n = 0;
    for (const t of this.taskMap().values()) if (t.background && !t.ambient && !ENDED.has(t.status)) n++;
    return n;
  },

  broadcastTasks() {
    this.broadcast({ t: 'tasks', tasks: this.tasksSummary() });
  },

  taskFor(id, init) {
    let t = this.taskMap().get(id);
    if (!t && init) {
      t = { id, kind: 'task', status: 'running', startedAt: Date.now(), background: false, description: '' };
      this.taskMap().set(id, t);
    }
    return t;
  },

  /** The Bash / Monitor / Agent call that started a task: its command and description. */
  describeFromToolUse(t) {
    if (!t.toolUseId || t.command) return;
    for (let i = this.events.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
      const e = this.events[i];
      if (e.k === 'block' && e.block?.type === 'tool_use' && e.block.id === t.toolUseId) {
        const inp = e.block.input || {};
        if (inp.command) t.command = String(inp.command).slice(0, 2000);
        if (!t.description && inp.description) t.description = String(inp.description);
        return;
      }
    }
  },

  onTaskMessage(msg) {
    const now = Date.now();
    switch (msg.subtype) {
      case 'task_started': {
        const t = this.taskFor(msg.task_id, true);
        t.type = msg.task_type || t.type;
        t.kind = KIND[t.type] || t.kind;
        t.description = msg.description || t.description;
        t.toolUseId = msg.tool_use_id || t.toolUseId;
        t.agentType = msg.subagent_type || t.agentType;
        t.ambient = !!(msg.ambient || msg.skip_transcript);
        // Older CLIs leave is_backgrounded out; Monitor, workflows and MCP tasks always run in the background.
        t.background = msg.is_backgrounded ?? (t.background || ['monitor', 'workflow', 'mcp'].includes(t.kind));
        if (!ENDED.has(t.status)) t.status = 'running';
        t.startedAt = t.startedAt && t.startedAt < now ? t.startedAt : now;
        this.describeFromToolUse(t);
        break;
      }
      case 'task_progress': {
        const t = this.taskFor(msg.task_id, true);
        if (msg.description) t.description = msg.description;
        if (msg.summary) t.summary = msg.summary;
        if (msg.last_tool_name) t.lastTool = msg.last_tool_name;
        if (msg.usage) t.usage = msg.usage;
        if (msg.subagent_type) t.agentType = msg.subagent_type;
        break;
      }
      case 'task_updated': {
        const t = this.taskFor(msg.task_id, true);
        const p = msg.patch || {};
        if (p.is_backgrounded) t.background = true;
        if (p.description) t.description = p.description;
        if (p.error) t.error = p.error;
        if (p.status) {
          t.status = p.status;
          if (ENDED.has(p.status)) t.endedAt = p.end_time || now;
        }
        break;
      }
      case 'task_notification': {
        const t = this.taskFor(msg.task_id, true);
        t.status = msg.status || 'completed';
        t.endedAt ||= now;
        if (msg.output_file) t.outputFile = msg.output_file;
        if (msg.summary) t.summary = msg.summary;
        break;
      }
      case 'background_tasks_changed': {
        // Level signal: every live background task. Anything we think is running that isn't listed has ended.
        const live = new Set();
        for (const x of msg.tasks || []) {
          live.add(x.task_id);
          const t = this.taskFor(x.task_id, true);
          t.type = x.task_type || t.type;
          t.kind = KIND[t.type] || t.kind;
          t.description = x.description || t.description;
          t.agentType = x.subagent_type || t.agentType;
          t.ambient = !!x.ambient;
          t.background = true;
          if (ENDED.has(t.status)) t.status = 'running';
        }
        for (const t of this.taskMap().values()) {
          if (t.background && !live.has(t.id) && !ENDED.has(t.status)) {
            t.status = 'completed';
            t.endedAt = now;
          }
        }
        break;
      }
    }
    this.pruneTasks();
    this.broadcastTasks();
  },

  pruneTasks() {
    const ended = [...this.taskMap().values()].filter((t) => ENDED.has(t.status) || !t.background).sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));
    for (const t of ended.slice(KEEP_ENDED)) this.taskMap().delete(t.id);
  },

  /** The Claude process went away: its background shells and agents went with it. */
  endTasksOnExit() {
    let changed = false;
    for (const t of this.taskMap().values()) {
      if (!ENDED.has(t.status)) {
        t.status = 'stopped';
        t.endedAt = Date.now();
        t.error ||= 'Claude stopped';
        changed = true;
      }
    }
    if (changed) this.broadcastTasks();
  },

  async taskOutput(id) {
    const t = this.taskMap().get(id);
    if (!t) throw new Error('No such background task');
    let output = '';
    if (t.kind === 'shell' || t.kind === 'monitor') {
      if (this.proc) {
        try {
          output = (await this.control({ subtype: 'get_task_output', task_id: id }, 8000))?.output || '';
        } catch (e) {
          if (!t.outputFile) throw e;
          output = readTail(t.outputFile);
        }
      } else if (t.outputFile) output = readTail(t.outputFile);
    }
    return { task: this.tasksSummary().find((x) => x.id === id) || null, output };
  },

  async stopTask(id) {
    const t = this.taskMap().get(id);
    if (!t) throw new Error('No such background task');
    if (ENDED.has(t.status)) return;
    if (!this.proc) throw new Error('Claude is not running');
    await this.control({ subtype: 'stop_task', task_id: id });
    // The CLI follows up with task_updated / task_notification; mark it now so the UI reacts at once.
    if (!ENDED.has(t.status)) {
      t.status = 'stopping';
      this.broadcastTasks();
    }
  },

  dismissTask(id) {
    const t = this.taskMap().get(id);
    if (t && ENDED.has(t.status)) this.taskMap().delete(id);
    this.broadcastTasks();
  },
};

function readTail(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
