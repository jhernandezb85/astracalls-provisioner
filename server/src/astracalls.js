'use strict';

const { HttpError, fetchT } = require('./util');

/**
 * Cliente de AstraCalls (v1.1.5). Rutas confirmadas en cmd/server/httpapi.go:
 *   POST   /api/sessions                      {name}            -> {id}   (ya inicia el pareamiento por QR)
 *   POST   /api/sessions/{sid}/pair                              -> 204    (reinicia QR)
 *   POST   /api/sessions/{sid}/pair-code      {phone}            -> {code}
 *   POST   /api/sessions/{sid}/chatwoot       {url,account_id,account_token,inbox_id,...}
 *   PUT    /api/sessions/{sid}/recording      {enabled}
 *   DELETE /api/sessions/{sid}                                   -> 204
 *   GET    /api/sessions                                         -> {sessions:[{id,state,paired,jid,...}]}
 *   GET    /api/events  (SSE)  eventos "session-qr" y "auth-state" (el QR NO está disponible por REST)
 */
class AstraCallsClient {
  constructor({ baseUrl, apiKey, publicUrl, timeoutMs, log }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.publicUrl = publicUrl;
    this.timeoutMs = timeoutMs;
    this.log = log;
    /** sid -> {state, paired, qr, code, jid, at} (alimentado por SSE) */
    this.auth = new Map();
    this._sseAbort = null;
    this._stopped = false;
  }

  webhookUrlFor(sid) {
    return `${this.publicUrl}/api/sessions/${sid}/chatwoot/webhook`;
  }

  async _req(method, path, body, { allow404 = false } = {}) {
    let res;
    try {
      res = await fetchT(this.baseUrl + path, {
        method,
        headers: { 'X-API-Key': this.apiKey, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }, this.timeoutMs);
    } catch (e) {
      throw new HttpError(504, e.timeout ? 'AstraCalls no respondió a tiempo.' : 'No se pudo conectar con AstraCalls.', 'astracalls_unreachable');
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (allow404 && res.status === 404) return { status: 404, data };
    if (!res.ok) {
      const detail = data && data.error ? String(data.error).slice(0, 200) : '';
      throw new HttpError(502, `AstraCalls rechazó la operación (${method} ${path.replace(/\/api\/sessions\/[^/]+/, '/api/sessions/{sid}')}, HTTP ${res.status})${detail ? ': ' + detail : ''}.`, 'astracalls_error');
    }
    return { status: res.status, data };
  }

  async createSession(name) {
    const r = await this._req('POST', '/api/sessions', { name });
    if (!r.data || !r.data.id) throw new HttpError(502, 'AstraCalls no devolvió el id de la sesión.', 'astracalls_error');
    return r.data.id;
  }

  async deleteSession(sid) {
    this.auth.delete(sid);
    await this._req('DELETE', `/api/sessions/${encodeURIComponent(sid)}`, undefined, { allow404: true });
  }

  async setChatwoot(sid, cfg) {
    await this._req('POST', `/api/sessions/${encodeURIComponent(sid)}/chatwoot`, cfg);
  }

  async setRecording(sid, enabled) {
    await this._req('PUT', `/api/sessions/${encodeURIComponent(sid)}/recording`, { enabled: !!enabled });
  }

  async pair(sid) {
    await this._req('POST', `/api/sessions/${encodeURIComponent(sid)}/pair`, {});
  }

  async pairCode(sid, phone) {
    const r = await this._req('POST', `/api/sessions/${encodeURIComponent(sid)}/pair-code`, { phone });
    if (!r.data || !r.data.code) throw new HttpError(502, 'AstraCalls no devolvió el código de emparejamiento.', 'astracalls_error');
    return String(r.data.code);
  }

  /** GET /api/sessions/{sid}/chatwoot → config (sin token); null si la sesión no existe. */
  async getChatwootCfg(sid) {
    const r = await this._req('GET', `/api/sessions/${encodeURIComponent(sid)}/chatwoot`, undefined, { allow404: true });
    if (r.status === 404) return null;
    if (!r.data || !r.data.chatwoot) return null;
    // device_bot: AstraCalls ya tiene el token del bot del celular (nunca lo devuelve)
    return { ...r.data.chatwoot, device_bot: !!r.data.device_bot };
  }

  async getRecording(sid) {
    const r = await this._req('GET', `/api/sessions/${encodeURIComponent(sid)}/recording`);
    return !!(r.data && r.data.enabled);
  }

  // ---- llaves MCP por sesión (cmd/server/mcpkeys.go) ----
  async listMcpKeys(sid) {
    const r = await this._req('GET', `/api/sessions/${encodeURIComponent(sid)}/mcp-keys`);
    return { keys: (r.data && r.data.keys) || [], max: (r.data && r.data.max) || 20 };
  }

  async createMcpKey(sid, name, readOnly) {
    const r = await this._req('POST', `/api/sessions/${encodeURIComponent(sid)}/mcp-keys`, { name, readOnly: !!readOnly });
    if (!r.data || !r.data.secret) throw new HttpError(502, 'AstraCalls no devolvió la llave MCP.', 'astracalls_error');
    return r.data; // {key, secret, endpoint, url}
  }

  mcpEndpoint() {
    return `${this.publicUrl}/mcp`;
  }

  /** Sesiones en espera de borrado (su bandeja de Chatwoot se borró). */
  async listOrphans() {
    const r = await this._req('GET', '/api/orphans');
    return (r.data && r.data.orphans) || [];
  }

  async listSessions() {
    const r = await this._req('GET', '/api/sessions');
    return (r.data && r.data.sessions) || [];
  }

  /** Estado combinado: SSE (QR/código) + lista REST (state/paired/jid) como respaldo. */
  async getAuth(sid) {
    let cached = this.auth.get(sid) || {};
    if (cached.paired === undefined) {
      try {
        const s = (await this.listSessions()).find((x) => x.id === sid);
        if (s) cached = { ...cached, state: cached.state || s.state, paired: !!s.paired, jid: s.jid || '' };
      } catch { /* respaldo best-effort */ }
    }
    return cached;
  }

  _merge(sid, patch) {
    const prev = this.auth.get(sid) || {};
    this.auth.set(sid, { ...prev, ...patch, at: Date.now() });
  }

  _onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'session-list' && Array.isArray(ev.sessions)) {
      const ids = new Set();
      for (const s of ev.sessions) {
        ids.add(s.id);
        const prev = this.auth.get(s.id) || {};
        // la lista trae state/paired/jid; el QR/código solo viene por session-qr/auth-state
        this._merge(s.id, { state: s.state, paired: !!s.paired, jid: s.jid || '', qr: prev.paired || s.paired ? '' : prev.qr, code: s.paired ? '' : prev.code });
      }
      for (const sid of [...this.auth.keys()]) if (!ids.has(sid)) this.auth.delete(sid);
    } else if (ev.type === 'session-qr' && ev.sessionId) {
      this._merge(ev.sessionId, { qr: ev.qr || '', state: 'qr', code: '' });
    } else if (ev.type === 'auth-state' && ev.sessionId) {
      this._merge(ev.sessionId, { state: ev.state, paired: !!ev.paired, qr: ev.qr || '', code: ev.code || '' });
    }
  }

  /** Mantiene una suscripción SSE a /api/events con reconexión. */
  startWatching() {
    this._stopped = false;
    const loop = async () => {
      let backoff = 1000;
      while (!this._stopped) {
        try {
          this._sseAbort = new AbortController();
          const res = await fetch(this.baseUrl + '/api/events?clientId=provisioner', {
            headers: { 'X-API-Key': this.apiKey, Accept: 'text/event-stream' },
            signal: this._sseAbort.signal,
          });
          if (!res.ok || !res.body) throw new Error('sse http ' + res.status);
          backoff = 1000;
          const dec = new TextDecoder();
          let buf = '';
          for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
              if (data) { try { this._onEvent(JSON.parse(data)); } catch { /* ignora */ } }
            }
          }
        } catch (e) {
          if (this._stopped) return;
          this.log && this.log.warn('SSE de AstraCalls desconectado; reintentando', { error: e && e.message });
        }
        if (this._stopped) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    };
    loop();
  }

  stopWatching() {
    this._stopped = true;
    if (this._sseAbort) this._sseAbort.abort();
  }
}

module.exports = { AstraCallsClient };
