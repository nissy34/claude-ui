import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { copyText } from '../ui/clipboard.js';

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').split(/\s/)[0];
      let html;
      try {
        html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
      } catch {
        html = escapeHtml(text);
      }
      return `<div class="codeblock"><div class="codeblock-head"><span>${escapeHtml(language || 'code')}</span><button class="copy-code" type="button">Copy</button></div><pre><code class="hljs">${html}</code></pre></div>`;
    },
  },
});

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(src) {
  return DOMPurify.sanitize(marked.parse(src || ''));
}

export function highlight(code, path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  const map = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', sh: 'bash', md: 'markdown', yml: 'yaml', json: 'json', css: 'css', html: 'xml', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', sql: 'sql', swift: 'swift', kt: 'kotlin' };
  const language = map[ext];
  try {
    return language ? hljs.highlight(code, { language }).value : escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}

// One delegated handler for all "Copy" buttons inside rendered markdown.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.copy-code');
  if (!btn) return;
  const code = btn.closest('.codeblock')?.querySelector('code')?.innerText || '';
  copyText(code).then((ok) => {
    if (!ok) return;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1200);
  });
});
