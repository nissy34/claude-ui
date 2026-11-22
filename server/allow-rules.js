// Permission rules for calls the user approved after auto mode blocked them.

const FILE_TOOLS = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path', Read: 'file_path' };

/**
 * The narrowest allow rule Claude Code understands for one call: the exact shell command, the one
 * file, the one site. Tools without a specifier (MCP tools and the like) get the tool's name.
 */
export function allowRuleFor(name, input = {}, cwd = '') {
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) return null;
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = typeof input?.command === 'string' ? input.command.trim() : '';
    return cmd && cmd.length <= 8000 ? `${name}(${cmd})` : null;
  }
  if (name === 'WebFetch') {
    try {
      return `WebFetch(domain:${new URL(input.url).hostname})`;
    } catch {
      return null;
    }
  }
  if (FILE_TOOLS[name]) {
    let p = String(input?.[FILE_TOOLS[name]] || '');
    if (p && !p.startsWith('/') && cwd.startsWith('/') && !/^[a-z]:[\\/]/i.test(p)) p = `${cwd.replace(/\/+$/, '')}/${p}`;
    if (!p.startsWith('/')) return name; // Windows paths: the tool itself
    // "//" = an absolute path. Edit rules cover every file-editing tool.
    return `${name === 'Read' ? 'Read' : 'Edit'}(/${p})`;
  }
  return name;
}

/** settings (or none) with these extra permissions.allow rules merged in. */
export function withAllowRules(settings, rules) {
  if (!rules?.length) return settings || null;
  const s = settings && typeof settings === 'object' ? settings : {};
  const perms = s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
  return { ...s, permissions: { ...perms, allow: [...new Set([...(Array.isArray(perms.allow) ? perms.allow : []), ...rules])] } };
}

/** The tool_result text Claude Code returns when auto mode's classifier blocked a call. */
export const CLASSIFIER_DENIED_RE = /denied by the Claude Code auto mode classifier/i;
