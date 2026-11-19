/**
 * In-app replacements for window.confirm / window.prompt, drawn with the design system's
 * Modal so they match the rest of the app (and work the same on phones).
 *
 *   if (!(await confirmDialog('Delete this chat?', { ok: 'Delete', danger: true }))) return;
 *   const name = await promptDialog('Rename chat', current); // null when cancelled
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Input, Modal, ModalBody, ModalFoot, ModalHead } from './index.jsx';

function show(render) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const done = (value) => {
      root.unmount();
      el.remove();
      resolve(value);
    };
    root.render(render(done));
  });
}

function ConfirmBox({ message, title, ok, danger, done }) {
  return (
    <Modal onClose={() => done(false)} className="ask-dialog">
      <ModalHead title={title} onClose={() => done(false)} />
      <ModalBody>
        <p className="ask-text">{message}</p>
      </ModalBody>
      <ModalFoot>
        <Button type="button" onClick={() => done(false)}>
          Cancel
        </Button>
        <Button type="button" variant={danger ? 'danger' : 'primary'} autoFocus onClick={() => done(true)}>
          {ok}
        </Button>
      </ModalFoot>
    </Modal>
  );
}

function PromptBox({ title, value, ok, placeholder, done }) {
  const [text, setText] = useState(value || '');
  return (
    <Modal onClose={() => done(null)} className="ask-dialog">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          done(text.trim() ? text : null);
        }}
      >
        <ModalHead title={title} onClose={() => done(null)} />
        <ModalBody>
          <Input autoFocus value={text} placeholder={placeholder} aria-label={title} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} />
        </ModalBody>
        <ModalFoot>
          <Button type="button" onClick={() => done(null)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!text.trim()}>
            {ok}
          </Button>
        </ModalFoot>
      </form>
    </Modal>
  );
}

/** Resolves true when confirmed. danger: red confirm button (deletes and the like). */
export function confirmDialog(message, { title = 'Are you sure?', ok = 'OK', danger = false } = {}) {
  return show((done) => <ConfirmBox message={message} title={title} ok={ok} danger={danger} done={done} />);
}

/** Resolves the entered text, or null when cancelled or left empty. */
export function promptDialog(title, value = '', { ok = 'Save', placeholder } = {}) {
  return show((done) => <PromptBox title={title} value={value} ok={ok} placeholder={placeholder} done={done} />);
}
