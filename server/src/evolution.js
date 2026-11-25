'use strict';

const { fetchT } = require('./util');

/**
 * Cliente mínimo de Evolution API (opcional). Se usa al conectar a AstraCalls una
 * bandeja que venía de Evolution: cuando el número ya quedó vinculado en
 * AstraCalls, se cierra la sesión de la instancia en Evolution para que los
 * mensajes no entren dos veces. Nunca se registra la API key.
 */
class EvolutionClient {
  constructor({ baseUrl, apiKey, timeoutMs }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  get enabled() {
    return !!(this.baseUrl && this.apiKey);
  }

  /**
   * Nombre de la instancia si el webhook de la bandeja es el de la integración de
   * Chatwoot de ESTE Evolution (`<EVOLUTION_URL>/chatwoot/webhook/<instancia>`); si no, null.
   */
  instanceFromWebhook(webhookUrl) {
    if (!this.enabled || typeof webhookUrl !== 'string' || !webhookUrl) return null;
    let u, base;
    try { u = new URL(webhookUrl); base = new URL(this.baseUrl); } catch { return null; }
    if (u.host.toLowerCase() !== base.host.toLowerCase()) return null;
    const prefix = base.pathname.replace(/\/+$/, '');
    if (!u.pathname.startsWith(prefix + '/chatwoot/webhook/')) return null;
    const m = u.pathname.slice(prefix.length).match(/^\/chatwoot\/webhook\/([^/]+)\/?$/);
    if (!m) return null;
    let name;
    try { name = decodeURIComponent(m[1]); } catch { return null; }
    return name && name.length <= 100 ? name : null;
  }

  /** Cierra la sesión de WhatsApp de la instancia (no la borra). true si quedó cerrada. */
  async logout(instance) {
    if (!this.enabled || !instance) return false;
    try {
      const r = await fetchT(`${this.baseUrl}/instance/logout/${encodeURIComponent(instance)}`, {
        method: 'DELETE',
        headers: { apikey: this.apiKey, Accept: 'application/json' },
      }, this.timeoutMs);
      // 400/404: la instancia ya estaba desconectada o no existe → nada que apagar
      return r.ok || r.status === 400 || r.status === 404;
    } catch {
      return false;
    }
  }
}

module.exports = { EvolutionClient };
