'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchT } = require('./util');

/**
 * API de conversiones de Meta (CAPI) para conversaciones de WhatsApp que llegaron
 * por un anuncio (Click to WhatsApp).
 *
 * - CapiStore: datos de Meta de cada cuenta en un archivo JSON del volumen. Los
 *   tokens (Meta y Chatwoot) se guardan cifrados con AES-256-GCM; la llave sale de
 *   la variable CAPI_SECRET y nunca se guarda en el archivo.
 * - CapiSender: recibe el webhook de la cuenta de Chatwoot y, cuando una
 *   conversación tiene la etiqueta de venta, `monto` y `ctwa_clid`, manda el
 *   evento Purchase a Meta una sola vez (atributo `capi_enviado` + event_id fijo).
 */

const SENT_ATTR = 'capi_enviado';
const GRAPH = 'https://graph.facebook.com/v22.0';

class CapiStore {
  constructor({ file, secret }) {
    this.file = file;
    this.key = secret ? crypto.createHash('sha256').update(String(secret)).digest() : null;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      this.data = {};
    }
  }

  get ready() { return !!this.key; }

  _enc(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), out].map((b) => b.toString('base64')).join('.');
  }

  _dec(blob) {
    if (!blob || !this.key) return '';
    try {
      const [iv, tag, out] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(out), d.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Registro de la cuenta con los tokens descifrados (uso interno), o null. */
  get(accountId) {
    const r = this.data[String(accountId)];
    if (!r) return null;
    return { ...r, metaToken: this._dec(r.metaToken), cwToken: this._dec(r.cwToken) };
  }

  /** Vista segura para la pantalla: sin tokens ni secreto del webhook. */
  view(accountId) {
    const r = this.data[String(accountId)];
    if (!r) return null;
    return {
      datasetId: r.datasetId, wabaId: r.wabaId, currency: r.currency, saleLabel: r.saleLabel,
      testEventCode: r.testEventCode || '', tokenHint: r.tokenHint || '', datasetName: r.datasetName || '',
      updatedAt: r.updatedAt,
    };
  }

  /** Guarda; metaToken vacío conserva el anterior. Devuelve el registro guardado. */
  set(accountId, fields) {
    if (!this.ready) throw new Error('CAPI_SECRET no configurado');
    const k = String(accountId);
    const prev = this.data[k] || {};
    const rec = {
      datasetId: fields.datasetId,
      wabaId: fields.wabaId,
      currency: fields.currency,
      saleLabel: fields.saleLabel,
      testEventCode: fields.testEventCode || '',
      datasetName: fields.datasetName || prev.datasetName || '',
      hookSecret: prev.hookSecret || crypto.randomBytes(24).toString('hex'),
      metaToken: fields.metaToken ? this._enc(fields.metaToken) : prev.metaToken,
      tokenHint: fields.metaToken ? '…' + String(fields.metaToken).slice(-4) : prev.tokenHint,
      cwToken: fields.cwToken ? this._enc(fields.cwToken) : prev.cwToken,
      updatedAt: new Date().toISOString(),
    };
    this.data[k] = rec;
    this._save();
    return rec;
  }
}

function digits(v) { return /^\d{5,25}$/.test(String(v || '').trim()) ? String(v).trim() : ''; }

/** Valida y normaliza lo que llega de la ventana. Devuelve { fields } o { error }. */
function cleanCapiFields(b, { hasToken }) {
  const datasetId = digits(b.datasetId);
  const wabaId = digits(b.wabaId);
  const currency = String(b.currency || 'PEN').trim().toUpperCase();
  const saleLabel = String(b.saleLabel || 'venta').trim().toLowerCase();
  const metaToken = String(b.metaToken || '').trim();
  const testEventCode = String(b.testEventCode || '').trim();
  if (!datasetId) return { error: 'El ID del conjunto de datos debe ser solo números.' };
  if (!wabaId) return { error: 'El ID de la cuenta de WhatsApp Business debe ser solo números.' };
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'La moneda debe ser un código de 3 letras (ej. PEN, USD).' };
  if (!/^[a-z0-9_-]{1,40}$/.test(saleLabel)) return { error: 'La etiqueta de venta solo puede tener letras, números, guiones y guiones bajos.' };
  if (!metaToken && !hasToken) return { error: 'Falta el token de acceso de Meta.' };
  if (metaToken && !/^[A-Za-z0-9_-]{20,1000}$/.test(metaToken)) return { error: 'El token de acceso no tiene el formato esperado.' };
  if (testEventCode && !/^[A-Za-z0-9_-]{1,40}$/.test(testEventCode)) return { error: 'El código de prueba no es válido.' };
  return { fields: { datasetId, wabaId, currency, saleLabel, metaToken, testEventCode } };
}

/** Monto como número > 0, aceptando "2,500.50", "2500" o "S/ 2500". */
function parseAmount(v) {
  if (typeof v === 'number') return v > 0 ? v : 0;
  const s = String(v || '').replace(/[^\d.,]/g, '');
  if (!s) return 0;
  const norm = s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(norm);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

class CapiSender {
  /**
   * @param {object} deps { store, cw (ChatwootClient), log, fetch?, now? }
   */
  constructor({ store, cw, log, fetch, now }) {
    this.store = store;
    this.cw = cw;
    this.log = log;
    this.fetch = fetch || ((u, o) => fetchT(u, o, 20000));
    this.now = now || (() => Date.now());
    this.inFlight = new Set();
    this.recent = new Map(); // conversación -> instante del envío (webhooks atrasados con atributos viejos)
  }

  /** Comprueba el token contra el dataset y devuelve su nombre. Lanza Error con mensaje en español. */
  async verifyDataset(datasetId, token) {
    let res;
    try {
      res = await this.fetch(`${GRAPH}/${datasetId}?fields=name`, { headers: { Authorization: 'Bearer ' + token } });
    } catch {
      throw new Error('No se pudo conectar con Meta. Intenta de nuevo.');
    }
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.id) return data.name || '';
    const err = (data && data.error) || {};
    // 190 = token inválido o vencido. Otros errores (ej. #100 Missing Permission)
    // aparecen con el token que genera el Administrador de eventos, que solo
    // permite ENVIAR eventos: en ese caso basta con que el token sea válido.
    if (Number(err.code) !== 190) {
      let me = null;
      try {
        const r2 = await this.fetch(`${GRAPH}/me?fields=id`, { headers: { Authorization: 'Bearer ' + token } });
        me = r2.ok ? await r2.json().catch(() => null) : null;
      } catch { me = null; }
      if (me && me.id) return '';
    }
    throw new Error('Meta rechazó el token: ' + (err.message || 'respuesta inesperada'));
  }

  /** Construye el evento Purchase para Meta. */
  buildEvent({ accountId, conversationId, cfg, ctwaClid, amount }) {
    return {
      event_name: 'Purchase',
      event_time: Math.floor(this.now() / 1000),
      event_id: `cw-${accountId}-${conversationId}-purchase`,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: cfg.wabaId, ctwa_clid: ctwaClid },
      custom_data: { currency: cfg.currency, value: amount },
    };
  }

  /**
   * Webhook de la cuenta (conversation_updated). Devuelve una razón corta
   * (para tests/log): 'sent', 'skip:*' o 'error:*'.
   */
  async handle(accountId, secret, body) {
    const cfg = this.store.get(accountId);
    if (!cfg || !secret || !cfg.hookSecret) return 'skip:no_config';
    const a = Buffer.from(String(secret));
    const b = Buffer.from(String(cfg.hookSecret));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'skip:bad_secret';
    if (!body || body.event !== 'conversation_updated') return 'skip:event';
    const convId = Number(body.id);
    if (!Number.isInteger(convId) || convId <= 0) return 'skip:no_conversation';
    if (body.account && Number(body.account.id) !== Number(accountId)) return 'skip:account';

    const labels = (Array.isArray(body.labels) ? body.labels : []).map((l) => String(l).toLowerCase());
    if (!labels.includes(cfg.saleLabel)) return 'skip:no_label';
    const attrs = body.custom_attributes && typeof body.custom_attributes === 'object' ? body.custom_attributes : {};
    if (attrs[SENT_ATTR]) return 'skip:already_sent';
    const ctwaClid = String(attrs.ctwa_clid || '').trim();
    if (!ctwaClid) return 'skip:no_clid';
    const amount = parseAmount(attrs.monto);
    if (!amount) return 'skip:no_amount';

    const key = `${accountId}:${convId}`;
    if (this.inFlight.has(key)) return 'skip:in_flight';
    const last = this.recent.get(key);
    // en modo prueba (código de prueba) se puede reenviar enseguida
    if (!cfg.testEventCode && last && this.now() - last < 2 * 60 * 1000) return 'skip:already_sent';
    this.inFlight.add(key);
    try {
      const event = this.buildEvent({ accountId, conversationId: convId, cfg, ctwaClid, amount });
      const payload = { data: [event] };
      if (cfg.testEventCode) payload.test_event_code = cfg.testEventCode;
      let res; let data = null;
      try {
        res = await this.fetch(`${GRAPH}/${cfg.datasetId}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.metaToken },
          body: JSON.stringify(payload),
        });
        data = await res.json().catch(() => null);
      } catch {
        res = null;
      }
      if (!res || !res.ok || !data || !data.events_received) {
        const m = data && data.error && data.error.message ? data.error.message : 'sin respuesta de Meta';
        this.log.warn('capi: Meta rechazó la venta', { accountId: Number(accountId), conversationId: convId });
        await this.cw.postPrivateNote(accountId, cfg.cwToken, convId,
          `⚠️ No se pudo avisar la venta a Meta: ${m}\nRevisa los datos en Integraciones → Meta · API de conversiones y vuelve a poner la etiqueta "${cfg.saleLabel}".`).catch(() => {});
        return 'error:meta';
      }
      const d = new Date(this.now());
      const stamp = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()} · ${amount} ${cfg.currency}` +
        (cfg.testEventCode ? ' · prueba' : '');
      const ok = await this.cw.mergeConversationAttributes(accountId, cfg.cwToken, convId, attrs, { [SENT_ATTR]: stamp }).catch(() => false);
      if (!ok) this.log.warn('capi: venta enviada pero no se pudo marcar capi_enviado', { accountId: Number(accountId), conversationId: convId });
      this.recent.set(key, this.now());
      for (const [k, t] of this.recent) if (this.now() - t > 2 * 60 * 1000) this.recent.delete(k);
      this.log.info('capi: venta enviada a Meta', { accountId: Number(accountId), conversationId: convId, test: !!cfg.testEventCode });
      return 'sent';
    } finally {
      this.inFlight.delete(key);
    }
  }
}

module.exports = { CapiStore, CapiSender, cleanCapiFields, parseAmount, SENT_ATTR };
