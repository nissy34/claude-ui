/**
 * Copy text. navigator.clipboard only exists on https or localhost, and the UI often runs
 * over plain http on a home network, so fall back to a hidden textarea + execCommand.
 * Resolves true when the text was copied.
 */
export async function copyText(text) {
  text = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  const active = document.activeElement;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}
