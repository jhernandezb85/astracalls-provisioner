'use strict';

const { HttpError, fetchT } = require('./util');

/**
 * Cliente mínimo de la API de aplicación de Chatwoot (v1).
 * Nunca se registran headers ni tokens.
 */
class ChatwootClient {
  constructor({ baseUrl, timeoutMs }) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async _json(method, path, headers, body) {
    let res;
    try {
      res = await fetchT(this.baseUrl + path, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }, this.timeoutMs);
    } catch (e) {
      throw new HttpError(504, e.timeout ? 'Chatwoot no respondió a tiempo.' : 'No se pudo conectar con Chatwoot.', 'chatwoot_unreachable');
    }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { status: res.status, ok: res.ok, data };
  }

  /** GET /api/v1/profile con los headers devise del usuario. */
  async getProfile(devise) {
    const r = await this._json('GET', '/api/v1/profile', devise);
    if (r.status === 401 || r.status === 403) throw new HttpError(401, 'Tu sesión de Chatwoot no es válida o expiró. Recarga la página e inicia sesión de nuevo.', 'session_invalid');
    if (!r.ok || !r.data) throw new HttpError(502, 'Chatwoot devolvió una respuesta inesperada al validar tu sesión.', 'chatwoot_error');
    return r.data;
  }

  /** POST /api/v1/accounts/{id}/inboxes  (bandeja de canal API). */
  async createApiInbox(accountId, accessToken, { name, webhookUrl }) {
    const r = await this._json('POST', `/api/v1/accounts/${accountId}/inboxes`, { api_access_token: accessToken }, {
      name,
      channel: { type: 'api', webhook_url: webhookUrl },
    });
    if (!r.ok || !r.data || !r.data.id) {
      const msg = r.status === 422 ? 'Chatwoot rechazó la bandeja (¿ya existe una con ese nombre?).' : 'No se pudo crear la bandeja en Chatwoot.';
      throw new HttpError(502, msg, 'inbox_create_failed');
    }
    return { id: r.data.id, identifier: r.data.inbox_identifier || r.data.identifier || '' };
  }

  /** GET /api/v1/accounts/{id}/inboxes → lista de bandejas de la cuenta. */
  async listInboxes(accountId, accessToken) {
    const r = await this._json('GET', `/api/v1/accounts/${accountId}/inboxes`, { api_access_token: accessToken });
    if (!r.ok || !r.data) throw new HttpError(502, 'No se pudo consultar las bandejas en Chatwoot.', 'inbox_list_failed');
    return Array.isArray(r.data.payload) ? r.data.payload : (Array.isArray(r.data) ? r.data : []);
  }

  /** GET /api/v1/accounts/{id}/inboxes/{inboxId} → bandeja (incluye webhook_url en canal API); null si no existe. */
  async getInbox(accountId, accessToken, inboxId) {
    const r = await this._json('GET', `/api/v1/accounts/${accountId}/inboxes/${inboxId}`, { api_access_token: accessToken });
    if (r.status === 404) return null;
    if (!r.ok || !r.data) throw new HttpError(502, 'No se pudo consultar la bandeja en Chatwoot.', 'inbox_get_failed');
    return r.data;
  }

  /**
   * Devuelve el token del Agent Bot de la cuenta con ese nombre, creándolo si no
   * existe. Lo usa AstraCalls para publicar lo que se escribe desde el celular
   * (Chatwoot no lo cuenta como respuesta humana). null si no se pudo.
   */
  async ensureAgentBot(accountId, accessToken, { name, description }) {
    const h = { api_access_token: accessToken };
    const tokenOf = (b) => {
      const t = b && b.access_token;
      return (t && typeof t === 'object' ? t.token : t) || '';
    };
    const list = await this._json('GET', `/api/v1/accounts/${accountId}/agent_bots`, h);
    const bots = list.ok && Array.isArray(list.data) ? list.data : [];
    let bot = bots.find((b) => b && b.name === name && Number(b.account_id) === Number(accountId) && !b.system_bot);
    if (!bot) {
      const r = await this._json('POST', `/api/v1/accounts/${accountId}/agent_bots`, h, { name, description });
      if (!r.ok || !r.data || !r.data.id) return null;
      bot = r.data;
    }
    if (!tokenOf(bot)) {
      const r = await this._json('GET', `/api/v1/accounts/${accountId}/agent_bots/${bot.id}`, h);
      if (r.ok && r.data) bot = r.data;
    }
    return tokenOf(bot) || null;
  }

  async deleteInbox(accountId, accessToken, inboxId) {
    const r = await this._json('DELETE', `/api/v1/accounts/${accountId}/inboxes/${inboxId}`, { api_access_token: accessToken });
    return r.ok || r.status === 404;
  }
}

module.exports = { ChatwootClient };
