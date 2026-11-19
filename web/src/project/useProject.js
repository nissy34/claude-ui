import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Live project detail: fetched once, then refetched whenever the server says it changed
// (App turns the "cprojects" websocket message into a window event).
export function useProject(id, onError) {
  const [project, setProject] = useState(null);
  const timer = useRef(null);
  const load = useCallback(() => {
    if (!id) return Promise.resolve();
    return api(`/api/cprojects/${id}`)
      .then((r) => setProject(r.project))
      .catch((e) => (e.status === 400 ? setProject(false) : onError?.(e)));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setProject(null);
    load();
    const onChange = (e) => {
      if (e.detail?.includes?.(id)) {
        clearTimeout(timer.current);
        timer.current = setTimeout(load, 80);
      }
    };
    window.addEventListener('cw-cproject-changed', onChange);
    // Statuses depend on live session state too (working, permission prompts): refresh now and then.
    const poll = setInterval(() => document.visibilityState === 'visible' && load(), 15_000);
    return () => {
      window.removeEventListener('cw-cproject-changed', onChange);
      clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, [id, load]);
  return [project, load, setProject];
}

export const STATUS_TONE = { waiting: 'accent', review: 'blue', working: 'green', queued: '', landing: 'purple', snoozed: 'warn', idle: '', resolved: '' };
export const STATUS_ORDER = ['waiting', 'review', 'working', 'queued', 'landing', 'snoozed', 'idle', 'resolved'];
export const STATUS_LABEL = { resolved: 'Resolved', snoozed: 'Snoozed', waiting: 'Waiting on you', working: 'Working', queued: 'Queued', landing: 'Landing', review: 'Ready for review', idle: 'Idle' };

export function projectAction(projectId, threadId, action, body) {
  return api(`/api/cprojects/${projectId}/threads/${threadId}/${action}`, { method: 'POST', body: body || {} });
}
