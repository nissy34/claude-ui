// Microsoft Graph for the Teams bridge: sign-in with the device code flow, a refresh token that is
// kept fresh in the background, and the few chat calls the bridge needs. Outbound HTTPS only.
import fs from 'node:fs';

const SCOPES = 'offline_access User.Read Chat.ReadWrite';

export class Graph {
  /**
   * @param {object} o
   * @param {string} o.tenant      Entra tenant id or domain
   * @param {string} o.clientId    app registration (public client flows on)
   * @param {string} o.tokenFile   where the refresh token is kept (mode 600)
   * @param {string} [o.graphUrl]  https://graph.microsoft.com/v1.0 (tests point it elsewhere)
   * @param {string} [o.loginUrl]  https://login.microsoftonline.com
   * @param {(info: {state: string, message: string, code?: string, url?: string}) => void} [o.onAuth]
   */
  constructor(o) {
    this.o = { graphUrl: 'https://graph.microsoft.com/v1.0', loginUrl: 'https://login.microsoftonline.com', ...o };
    this.tokens = null;
    try {
      this.tokens = JSON.parse(fs.readFileSync(o.tokenFile, 'utf8'));
    } catch {}
    this.signingIn = null;
  }

  authUrl(p) {
    return `${this.o.loginUrl}/${encodeURIComponent(this.o.tenant)}/oauth2/v2.0/${p}`;
  }

  save(t) {
    this.tokens = { access: t.access_token, refresh: t.refresh_token || this.tokens?.refresh, expires: Date.now() + (Number(t.expires_in) || 3600) * 1000, savedAt: Date.now() };
    fs.writeFileSync(this.o.tokenFile, JSON.stringify(this.tokens), { mode: 0o600 });
  }

  async form(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, j };
  }

  /** Swap the refresh token for a new pair. Returns false when a person has to sign in again. */
  async refresh() {
    if (!this.tokens?.refresh) return false;
    const r = await this.form(this.authUrl('token'), { grant_type: 'refresh_token', client_id: this.o.clientId, refresh_token: this.tokens.refresh, scope: SCOPES });
    if (r.ok) {
      this.save(r.j);
      return true;
    }
    // invalid_grant / interaction_required: the refresh token is dead (expired, revoked or a sign-in
    // frequency policy). Anything else (network, 5xx) is worth retrying later.
    if (['invalid_grant', 'interaction_required', 'invalid_client', 'unauthorized_client'].includes(r.j.error)) {
      this.tokens = { ...this.tokens, refresh: null };
      return false;
    }
    throw new Error(`token refresh failed: ${r.j.error_description || r.status}`);
  }

  /** Device code sign-in: tells the person a code to enter at microsoft.com/devicelogin, then waits. */
  async deviceLogin() {
    if (this.signingIn) return this.signingIn;
    this.signingIn = (async () => {
      for (;;) {
        const d = await this.form(this.authUrl('devicecode'), { client_id: this.o.clientId, scope: SCOPES });
        if (!d.ok) throw new Error(`device code request failed: ${d.j.error_description || d.status}`);
        this.o.onAuth?.({ state: 'signin', message: d.j.message, code: d.j.user_code, url: d.j.verification_uri });
        const until = Date.now() + (Number(d.j.expires_in) || 900) * 1000;
        let every = (Number(d.j.interval) || 5) * 1000;
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, every));
          const t = await this.form(this.authUrl('token'), { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: this.o.clientId, device_code: d.j.device_code });
          if (t.ok) {
            this.save(t.j);
            this.o.onAuth?.({ state: 'ok', message: 'Signed in to Microsoft Teams.' });
            return;
          }
          if (t.j.error === 'slow_down') every += 5000;
          else if (t.j.error !== 'authorization_pending') throw new Error(`sign-in failed: ${t.j.error_description || t.j.error}`);
        }
        // The code expired unused: ask again with a new one.
      }
    })().finally(() => (this.signingIn = null));
    return this.signingIn;
  }

  /** A valid access token, refreshing (or signing in) as needed. */
  async token() {
    if (this.tokens?.access && this.tokens.expires - Date.now() > 5 * 60_000) return this.tokens.access;
    if (await this.refresh()) return this.tokens.access;
    await this.deviceLogin();
    return this.tokens.access;
  }

  /**
   * Keep the refresh token alive: refresh well before the access token runs out, even when nothing
   * else is happening, so an unused weekend doesn't end in a sign-in. Refresh tokens roll forward
   * on every use; only a tenant policy (sign-in frequency) can still force a new sign-in.
   */
  keepAlive() {
    const tick = async () => {
      try {
        if (this.tokens?.refresh && this.tokens.expires - Date.now() < 15 * 60_000) {
          if (!(await this.refresh())) this.o.onAuth?.({ state: 'expired', message: 'The Microsoft sign-in expired.' });
        }
      } catch {}
    };
    const t = setInterval(tick, 60_000);
    t.unref?.();
  }

  async call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(path.startsWith('http') ? path : this.o.graphUrl + path, {
        method,
        headers: { authorization: `Bearer ${await this.token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        this.tokens.expires = 0; // force a refresh
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt * 2, 60) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(`Graph ${method} ${path}: ${j.error?.message || res.status}`);
        e.status = res.status;
        throw e;
      }
      return j;
    }
  }

  me() {
    return this.call('GET', '/me?$select=id,displayName,userPrincipalName');
  }

  chats() {
    return this.call('GET', '/me/chats?$top=50&$expand=members&$orderby=lastMessagePreview/createdDateTime desc');
  }

  /** The newest messages of a chat, newest first. */
  recent(chatId, top = 20) {
    return this.call('GET', `/chats/${encodeURIComponent(chatId)}/messages?$top=${top}&$orderby=createdDateTime desc`);
  }

  send(chatId, html) {
    return this.call('POST', `/chats/${encodeURIComponent(chatId)}/messages`, { body: { contentType: 'html', content: html } });
  }

  edit(chatId, messageId, html) {
    return this.call('PATCH', `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, { body: { contentType: 'html', content: html } });
  }
}
