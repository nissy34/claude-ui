// Sign-ins whose link only opens on this machine (http://localhost:<port>/…), finished from a phone
// through the Teams bridge. Two shapes:
//
//  sso   The localhost page only redirects to a real sign-in page on the internet (Microsoft, Google…)
//        and waits for the browser to come back to localhost. We open the localhost link here, take the
//        address it redirects to (without following it) and hand that out. The phone signs in and ends
//        on a localhost page that can't load; the person pastes that address back and we open it here,
//        with the cookies the first visit got, as the browser would have.
//
//  form  The localhost page is a username/password form. The password must never be readable in
//        Teams, so the person types it on a static page (docs/seal.html) that encrypts it on the phone
//        for a one-time key made here (ECDH P-256 + HKDF + AES-GCM, WebCrypto on both sides) and
//        replies with the scrambled code. We decrypt it here, submit the form to the localhost page and
//        forget the key. The values are never logged, stored, or shown to a model.
import http from 'node:http';
import crypto from 'node:crypto';

const { subtle } = crypto.webcrypto;
const LOOP_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
export const SEAL_TTL = Number(process.env.CW_SEAL_TTL_MS) || 10 * 60_000;
const MAX_HOPS = 5;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

export function loopbackUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'http:' && LOOP_HOST.test(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** The callback address the person pasted: a localhost address, anywhere in their words. */
export function findCallback(text) {
  for (const m of String(text || '').matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/[^\s<>"']*/gi)) {
    const u = loopbackUrl(m[0].replace(/[).,;]+$/, ''));
    if (u) return u;
  }
  return null;
}

/** A sealed reply: cw1.<seal id>.<ephemeral key>.<iv>.<ciphertext>, anywhere in the words. */
export function findSealed(text) {
  const m = /\bcw1\.([A-Za-z0-9_-]{6,40})\.([A-Za-z0-9_-]{40,200})\.([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{16,8000})/.exec(String(text || '').replace(/\s+/g, ''));
  return m ? { sid: m[1], epk: m[2], iv: m[3], ct: m[4], raw: m[0] } : null;
}

// ---------- cookies ----------
function storeCookies(jar, res) {
  const set = res.headers['set-cookie'] || [];
  for (const c of set) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** One HTTP request to a localhost address, trying IPv4 then IPv6 for "localhost". */
function loopRequest(url, { method = 'GET', headers = {}, body = null, jar } = {}) {
  const hosts = url.hostname === '127.0.0.1' ? ['127.0.0.1'] : url.hostname === '[::1]' ? ['::1'] : ['127.0.0.1', '::1'];
  const port = Number(url.port || 80);
  const h = { host: url.host, 'user-agent': 'Mozilla/5.0 (claude-ui sign-in relay)', accept: 'text/html,*/*', ...headers };
  if (jar?.size) h.cookie = cookieHeader(jar);
  if (body != null) h['content-length'] = Buffer.byteLength(body);
  let firstErr;
  const tryHost = (i) =>
    new Promise((resolve, reject) => {
      const rq = http.request({ host: hosts[i], port, method, path: url.pathname + url.search, headers: h, timeout: 15_000 }, (r) => {
        if (jar) storeCookies(jar, r);
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (d) => text.length < 200_000 && (text += d));
        r.on('end', () => resolve({ status: r.statusCode, location: r.headers.location || null, type: String(r.headers['content-type'] || ''), text }));
      });
      rq.on('timeout', () => rq.destroy(new Error('timed out')));
      rq.on('error', (e) => {
        firstErr ||= e;
        if (i + 1 < hosts.length && e.message !== 'timed out') tryHost(i + 1).then(resolve, reject);
        else reject(firstErr);
      });
      if (body != null) rq.write(body);
      rq.end();
    });
  return tryHost(0).catch((e) => {
    throw new Error(e.code === 'ECONNREFUSED' ? `Nothing is listening on port ${port} any more. The sign-in may have timed out; start it again.` : `Couldn't reach the sign-in page on this server: ${e.message}`);
  });
}

// ---------- reading the localhost page ----------
const attrs = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
};
const decode = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
const textOf = (html) => decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** A username/password form on the page: where it posts and its fields. Null when there is none. */
export function parseForm(html, pageUrl) {
  for (const fm of String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const fa = attrs(fm[1]);
    const inner = fm[2];
    const labels = {};
    for (const lm of inner.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
      const la = attrs(lm[1]);
      if (la.for) labels[la.for] = textOf(lm[2]);
    }
    const fields = [];
    const hidden = [];
    for (const im of inner.matchAll(/<input\b([^>]*)>/gi)) {
      const a = attrs(im[1]);
      if (!a.name) continue;
      const type = (a.type || 'text').toLowerCase();
      if (type === 'hidden') hidden.push({ name: a.name, value: a.value || '' });
      else if (['text', 'email', 'password', 'tel', 'number', ''].includes(type)) fields.push({ name: a.name, type: type === 'password' ? 'password' : 'text', label: labels[a.id] || a['aria-label'] || a.placeholder || a.name });
      else if (type === 'checkbox' && 'checked' in a) hidden.push({ name: a.name, value: a.value || 'on' });
    }
    if (!fields.some((f) => f.type === 'password')) continue;
    let action;
    try {
      action = new URL(fa.action || pageUrl.href, pageUrl);
    } catch {
      continue;
    }
    if (!loopbackUrl(action.href) || action.port !== pageUrl.port) continue; // only back to the same page's server
    return { action: action.href, method: (fa.method || 'post').toLowerCase() === 'get' ? 'get' : 'post', fields: fields.slice(0, 6), hidden: hidden.slice(0, 30) };
  }
  return null;
}

/** An https sign-in address a page sends the browser to without a redirect: meta refresh or a script. */
function softRedirect(html, pageUrl) {
  const meta = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i.exec(html);
  const cands = [];
  if (meta) {
    const c = /url\s*=\s*['"]?([^'">\s]+)/i.exec(attrs(meta[0]).content || '');
    if (c) cands.push(c[1]);
  }
  const js = /(?:window\.|document\.)?location(?:\.href)?\s*(?:=|\.assign\(|\.replace\()\s*["']([^"']+)["']/i.exec(html);
  if (js) cands.push(js[1]);
  for (const c of cands) {
    try {
      const u = new URL(decode(c), pageUrl);
      if (u.protocol === 'https:') return u.href;
    } catch {}
  }
  return null;
}

/**
 * Open a localhost sign-in link here and work out its shape. Redirects to other localhost addresses
 * are followed; the first one leaving the machine is the sign-in page.
 * { kind: 'sso', signinUrl, port, jar } | { kind: 'form', form, port, jar } | { kind: 'unknown', port, why }
 */
export async function probe(raw) {
  let url = loopbackUrl(raw);
  if (!url) return { kind: 'unknown', why: 'not a localhost link' };
  const port = url.port || '80';
  const jar = new Map();
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let r;
    try {
      r = await loopRequest(url, { jar });
    } catch (e) {
      return { kind: 'unknown', port, why: e.message };
    }
    if (r.status >= 300 && r.status < 400 && r.location) {
      let next;
      try {
        next = new URL(r.location, url);
      } catch {
        return { kind: 'unknown', port, why: 'bad redirect' };
      }
      if (loopbackUrl(next.href)) {
        if ((next.port || '80') !== port) return { kind: 'unknown', port, why: 'redirects to another local server' };
        url = next;
        continue;
      }
      if (next.protocol !== 'https:') return { kind: 'unknown', port, why: 'redirects to a non-https page' };
      return { kind: 'sso', signinUrl: next.href, port, jar };
    }
    if (r.status >= 200 && r.status < 300 && /html/i.test(r.type || 'text/html')) {
      const form = parseForm(r.text, url);
      if (form) return { kind: 'form', form, port, jar, page: url.href };
      const soft = softRedirect(r.text, url);
      if (soft) return { kind: 'sso', signinUrl: soft, port, jar };
    }
    return { kind: 'unknown', port, why: `the page answered HTTP ${r.status} with nothing to follow` };
  }
  return { kind: 'unknown', port, why: 'too many redirects' };
}

/** Open the pasted callback address here, on the same local server, with the first visit's cookies. */
export async function deliverCallback(flow, url) {
  if (!loopbackUrl(url.href)) throw new Error('That is not a localhost address.');
  if ((url.port || '80') !== flow.port) throw new Error(`That address is for port ${url.port || 80}, but this sign-in waits on port ${flow.port}.`);
  let cur = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const r = await loopRequest(cur, { jar: flow.jar });
    if (r.status >= 300 && r.status < 400 && r.location) {
      const next = new URL(r.location, cur);
      if (loopbackUrl(next.href) && (next.port || '80') === flow.port) {
        cur = next;
        continue;
      }
      return { ok: true, status: r.status };
    }
    return { ok: r.status < 400, status: r.status, body: textOf(r.text).slice(0, 200) };
  }
  return { ok: true, status: 302 };
}

/** Submit the decrypted values to the localhost form. ok: the page didn't show the form again. */
export async function submitForm(flow, values) {
  const { form } = flow;
  const params = new URLSearchParams();
  for (const h of form.hidden) params.append(h.name, h.value);
  for (const f of form.fields) params.append(f.name, String(values[f.name] ?? ''));
  const body = params.toString();
  let url = new URL(form.action);
  let r = form.method === 'get' ? await loopRequest(new URL(`${url.origin}${url.pathname}?${body}`), { jar: flow.jar }) : await loopRequest(url, { method: 'POST', body, jar: flow.jar, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: url.origin, referer: flow.page || url.href } });
  for (let hop = 0; hop < MAX_HOPS && r.status >= 300 && r.status < 400 && r.location; hop++) {
    const next = new URL(r.location, url);
    if (!loopbackUrl(next.href) || (next.port || '80') !== flow.port) return { ok: true, status: r.status };
    url = next;
    r = await loopRequest(url, { jar: flow.jar });
  }
  if (r.status >= 400) return { ok: false, status: r.status, note: textOf(r.text).slice(0, 200) };
  if (parseForm(r.text, url)) return { ok: false, status: r.status, note: textOf(r.text.replace(/<form\b[\s\S]*?<\/form>/gi, ' ')).slice(0, 200) || 'The page showed the sign-in form again.' };
  return { ok: true, status: r.status };
}

// ---------- the one-time key ----------
async function aesKey(priv, epkRaw, sid) {
  const epk = await subtle.importKey('raw', epkRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(sid), info: new TextEncoder().encode('cw-seal-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt', 'encrypt']);
}

/** A fresh one-time key: { sid, pub (raw, base64url), priv, exp }. */
export async function newSeal() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = b64u(await subtle.exportKey('raw', kp.publicKey));
  return { sid: crypto.randomBytes(9).toString('base64url'), pub, priv: kp.privateKey, exp: Date.now() + SEAL_TTL };
}

/** The address of the encrypt page for this seal. Everything is after the #, which browsers never send. */
export function sealLink(base, seal, { server, fields }) {
  const f = b64u(Buffer.from(JSON.stringify(fields.map((x) => ({ n: x.name, l: x.label, t: x.type })))));
  const q = new URLSearchParams({ v: '1', id: seal.sid, k: seal.pub, s: String(server || '').slice(0, 80), f, e: String(seal.exp) });
  return `${base}#${q.toString()}`;
}

/** Decrypt a sealed reply with its one-time key. Throws on anything off. */
export async function openSealed(seal, sealed) {
  if (Date.now() > seal.exp) throw new Error('expired');
  const key = await aesKey(seal.priv, unb64u(sealed.epk), seal.sid);
  let plainBuf;
  try {
    plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(sealed.iv), additionalData: new TextEncoder().encode(seal.sid) }, key, unb64u(sealed.ct));
  } catch {
    throw new Error("That code doesn't decrypt. Copy the whole code from the page and try again.");
  }
  const v = JSON.parse(new TextDecoder().decode(plainBuf));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('That code is not a sign-in.');
  return v;
}

/** Encrypt like docs/seal.html does (for tests). */
export async function sealFor(sid, pubB64, values) {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const server = await subtle.importKey('raw', unb64u(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: server }, kp.privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(sid), info: new TextEncoder().encode('cw-seal-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(sid) }, key, new TextEncoder().encode(JSON.stringify(values)));
  return `cw1.${sid}.${b64u(await subtle.exportKey('raw', kp.publicKey))}.${b64u(iv)}.${b64u(ct)}`;
}
