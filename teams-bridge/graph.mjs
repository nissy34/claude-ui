// Microsoft Graph for the Teams bridge: sign-in with the device code flow, a refresh token that is
// kept fresh in the background, and the few chat calls the bridge needs. Outbound HTTPS only.
import fs from 'node:fs';
import crypto from 'node:crypto';

const SCOPES = 'offline_access User.Read Chat.ReadWrite';
// Channel mode needs ChannelMessage.Send / Read.All, Team.ReadBasic.All, Channel.ReadBasic.All (and
// optionally ChannelMessage.ReadWrite). ".default" asks for whatever the app registration has been
// granted, so a permission added later is picked up at the next token refresh.
export const CHANNEL_SCOPES = 'offline_access https://graph.microsoft.com/.default';

export class Graph {
  /**
   * @param {object} o
   * @param {string} o.tenant      Entra tenant id or domain
   * @param {string} o.clientId    app registration (public client flows on)
   * @param {string} o.tokenFile   where the refresh token is kept (mode 600)
   * @param {string} [o.graphUrl]  https://graph.microsoft.com/v1.0 (tests point it elsewhere)
   * @param {string} [o.loginUrl]  https://login.microsoftonline.com
   * @param {'auto'|'device'|'browser'} [o.auth]  sign-in method (default browser); auto tries a device code first, then the browser
   * @param {() => Promise<string|null>} [o.waitForReply]  resolves with the pasted http://localhost/?code=… URL
   * @param {(info: {state: string, message: string, code?: string, url?: string}) => void} [o.onAuth]
   */
  constructor(o) {
    // Unset options (undefined) keep the defaults.
    this.o = { graphUrl: 'https://graph.microsoft.com/v1.0', loginUrl: 'https://login.microsoftonline.com', auth: 'browser', redirectUri: 'http://localhost', ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) };
    this.tokens = null;
    try {
      this.tokens = JSON.parse(fs.readFileSync(o.tokenFile, 'utf8'));
    } catch {}
    this.signingIn = null;
  }

  get scopes() {
    return this.o.scopes || SCOPES;
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
    const r = await this.form(this.authUrl('token'), { grant_type: 'refresh_token', client_id: this.o.clientId, refresh_token: this.tokens.refresh, scope: this.scopes });
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
    return (async () => {
      for (;;) {
        const d = await this.form(this.authUrl('devicecode'), { client_id: this.o.clientId, scope: this.scopes });
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
        // The code expired unused: ask again with a new one (in auto mode, try the browser instead).
        if (this.o.auth === 'auto') throw new Error('the code expired unused');
      }
    })();
  }

  /** A valid access token, refreshing (or signing in) as needed. */
  async token() {
    if (this.tokens?.access && this.tokens.expires - Date.now() > 5 * 60_000) return this.tokens.access;
    if (await this.refresh()) return this.tokens.access;
    await this.signIn();
    return this.tokens.access;
  }

  /** Signed in again elsewhere (e.g. `bridge.mjs login`)? Pick up a newer token file. */
  reload() {
    try {
      const t = JSON.parse(fs.readFileSync(this.o.tokenFile, 'utf8'));
      if (t.refresh && t.savedAt > (this.tokens?.savedAt || 0)) {
        this.tokens = t;
        return true;
      }
    } catch {}
    return false;
  }

  async signIn() {
    if (this.signingIn) return this.signingIn;
    this.signingIn = (async () => {
      if (this.o.auth !== 'browser') {
        try {
          return await this.deviceLogin();
        } catch (e) {
          if (this.o.auth === 'device') throw e;
          this.o.onAuth?.({ state: 'device-failed', message: `Device code sign-in didn't work (${e.message}). Switching to browser sign-in.` });
        }
      }
      return this.browserLogin();
    })().finally(() => (this.signingIn = null));
    return this.signingIn;
  }

  /** The browser sign-in link (authorization code with PKCE, redirect to http://localhost). */
  browserStart() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(12).toString('base64url');
    const q = new URLSearchParams({
      client_id: this.o.clientId,
      response_type: 'code',
      redirect_uri: this.o.redirectUri,
      response_mode: 'query',
      scope: this.scopes,
      state,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    this.pkce = { verifier, state, at: Date.now() };
    return `${this.authUrl('authorize')}?${q}`;
  }

  /** Finish a browser sign-in with the address the browser ended on (http://localhost/?code=…). */
  async browserFinish(pasted) {
    let u;
    try {
      u = new URL(String(pasted || '').trim());
    } catch {
      throw new Error('That is not the address from the browser. Copy the whole http://localhost/?code=… address.');
    }
    const err = u.searchParams.get('error');
    if (err) throw new Error(`Microsoft said: ${u.searchParams.get('error_description') || err}`);
    const code = u.searchParams.get('code');
    if (!code) throw new Error('No code in that address. Copy the whole address after signing in.');
    if (!this.pkce || u.searchParams.get('state') !== this.pkce.state) throw new Error('That address belongs to an older sign-in link. Open the newest link and try again.');
    const t = await this.form(this.authUrl('token'), { grant_type: 'authorization_code', client_id: this.o.clientId, code, redirect_uri: this.o.redirectUri, code_verifier: this.pkce.verifier, scope: this.scopes });
    if (!t.ok) throw new Error(`sign-in failed: ${t.j.error_description || t.j.error || t.status}`);
    this.pkce = null;
    this.save(t.j);
    this.o.onAuth?.({ state: 'ok', message: 'Signed in to Microsoft Teams.' });
  }

  async browserLogin() {
    for (;;) {
      const url = this.browserStart();
      this.o.onAuth?.({ state: 'signin-browser', message: 'Sign in to Microsoft in your browser, then paste the address it ends on (http://localhost/?code=…).', url });
      const until = Date.now() + 9 * 60_000; // codes are short-lived: offer a fresh link after a while
      while (Date.now() < until) {
        if (this.reload()) return;
        const reply = this.o.waitForReply ? await this.o.waitForReply() : null;
        if (reply) {
          try {
            return await this.browserFinish(reply);
          } catch (e) {
            this.o.onAuth?.({ state: 'signin-error', message: e.message });
          }
        } else await new Promise((r) => setTimeout(r, 3000));
      }
    }
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

  send(chatId, html, quote) {
    return this.call('POST', `/chats/${encodeURIComponent(chatId)}/messages`, this.msgBody(html, null, quote));
  }

  /** A message holding one Adaptive Card. */
  sendCard(chatId, card) {
    const id = `c${Date.now().toString(36)}`;
    return this.call('POST', `/chats/${encodeURIComponent(chatId)}/messages`, { body: { contentType: 'html', content: `<attachment id="${id}"></attachment>` }, attachments: [{ id, contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: JSON.stringify(card) }] });
  }

  editCard(chatId, messageId, card) {
    const id = `c${Date.now().toString(36)}`;
    return this.call('PATCH', `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, { body: { contentType: 'html', content: `<attachment id="${id}"></attachment>` }, attachments: [{ id, contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: JSON.stringify(card) }] });
  }

  // ----- channels: one thread per topic -----
  teams() {
    return this.call('GET', '/me/joinedTeams?$select=id,displayName');
  }

  channels(teamId) {
    return this.call('GET', `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`);
  }

  chanPath(c, id, root) {
    const base = `/teams/${encodeURIComponent(c.team)}/channels/${encodeURIComponent(c.channel)}/messages`;
    if (!id) return base;
    return root ? `${base}/${encodeURIComponent(root)}/replies/${encodeURIComponent(id)}` : `${base}/${encodeURIComponent(id)}`;
  }

  /** The newest threads of a channel, with their replies. */
  channelRecent(c, top = 20) {
    return this.call('GET', `${this.chanPath(c)}?$top=${top}&$expand=replies`);
  }

  /** Post in a channel: a new thread, or a reply in thread `root`. */
  channelSend(c, root, html, card, subject, quote) {
    const url = root ? `${this.chanPath(c)}/${encodeURIComponent(root)}/replies` : this.chanPath(c);
    return this.call('POST', url, { ...this.msgBody(html, card, quote), ...(subject && !root ? { subject } : {}) });
  }

  /** Rename a thread (its first post's subject). Needs ChannelMessage.ReadWrite. */
  channelRename(c, id, subject) {
    return this.call('PATCH', this.chanPath(c, id), { subject });
  }

  channelEdit(c, id, root, html, card) {
    return this.call('PATCH', this.chanPath(c, id, root), this.msgBody(html, card));
  }

  /** Delete a thread (its first post) or a reply. Needs ChannelMessage.ReadWrite. */
  channelDelete(c, id, root) {
    return this.call('POST', `${this.chanPath(c, id, root)}/softDelete`);
  }

  /** Add (or with on=false take away) a reaction. `where` is a chat id, or { chan, root } in a channel. */
  react(where, id, emoji, on = true) {
    const base = typeof where === 'string' ? `/chats/${encodeURIComponent(where)}/messages/${encodeURIComponent(id)}` : this.chanPath(where.chan, id, where.root);
    return this.call('POST', `${base}/${on ? 'setReaction' : 'unsetReaction'}`, { reactionType: emoji });
  }

  /** quote: { id, preview, user: { id, displayName } } shows the message as a quote above the text (a "quote reply"). */
  msgBody(html, card, quote) {
    if (quote && !card) {
      const ref = { id: quote.id, contentType: 'messageReference', contentUrl: null, content: JSON.stringify({ messageId: quote.id, messagePreview: String(quote.preview || '').slice(0, 120), messageSender: { user: quote.user || null } }) };
      return { body: { contentType: 'html', content: `<attachment id="${quote.id}"></attachment>${html}` }, attachments: [ref] };
    }
    if (!card) return { body: { contentType: 'html', content: html } };
    const id = `c${Date.now().toString(36)}`;
    return { body: { contentType: 'html', content: `<attachment id="${id}"></attachment>` }, attachments: [{ id, contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: JSON.stringify(card) }] };
  }

  edit(chatId, messageId, html) {
    return this.call('PATCH', `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, { body: { contentType: 'html', content: html } });
  }
}
