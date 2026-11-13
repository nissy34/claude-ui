import { useEffect, useState } from 'react';
import { api } from './api.js';

// The models this account can use, as the claude CLI reports them (fetched once per page load).
let cache = null;
let inflight = null;

export function loadModels() {
  if (cache) return Promise.resolve(cache);
  inflight ||= api('/api/claude/models')
    .then((r) => (cache = (r.models || []).map((m) => ({ ...m, id: m.value === 'default' ? '' : m.value }))))
    .catch(() => {
      inflight = null;
      return [];
    });
  return inflight;
}

export function useModels() {
  const [models, setModels] = useState(cache || []);
  useEffect(() => {
    let live = true;
    loadModels().then((m) => live && setModels(m));
    return () => {
      live = false;
    };
  }, []);
  return models;
}

const bare = (id) => (id || '').replace(/\[.*\]$/, '');

/** The model entry for a picked id, or for the model actually running. */
export function findModel(models, id, active) {
  if (id) return models.find((m) => m.id === id) || models.find((m) => m.resolvedModel === bare(id));
  const def = models.find((m) => m.id === '');
  const resolved = bare(active) || def?.resolvedModel;
  return models.find((m) => m.id && m.resolvedModel === resolved) || def;
}

/** "Opus 5.5": the versioned name to show on buttons. */
export function modelLabel(models, id, active) {
  const m = findModel(models, id, active);
  if (m && m.id) return m.displayName;
  if (id) return id.replace(/^claude-/, '');
  return active ? bare(active).replace(/^claude-/, '') : 'Model';
}
