'use strict';

const { HttpError, normalizePhone, sanitizeInboxName, sha256, newId } = require('./util');

const PROFILE_CACHE_MS = 15000;
const REPAIR_MIN_INTERVAL_MS = 20000;
const QR_GRACE_MS = 8000;

class Provisioner {
  /**
   * @param {object} deps { cfg, chatwoot, astracalls, log, now? }
   */
  constructor({ cfg, chatwoot, astracalls, log, now }) {
    this.cfg = cfg;
    this.cw = chatwoot;
    this.ac = astracalls;
    this.log = log;
    this.now = now || (() => Date.now());
    /** provisionId -> entrada de estado (en memoria, sin BD) */
    this.items = new Map();
    this.profileCache = new Map();
    this.accountHistory = new Map(); // accountId -> [timestamps] de aprovisionamientos
    this._sweeper = null;
  }

  start() {
    this._sweeper = setInterval(() => this.sweep().catch(() => {}), 60000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  stop() {
    if (this._sweeper) clearInterval(this._sweeper);
  }

  // ---------- validación de usuario ----------

  async _profile(devise) {
    const key = sha256(devise['access-token'] + '|' + devise.client + '|' + devise.uid);
    const hit = this.profileCache.get(key);
    const t = this.now();
    if (hit && t - hit.at < PROFILE_CACHE_MS) return hit.profile;
    const profile = await this.cw.getProfile(devise);
    this.profileCache.set(key, { profile, at: t });
    return profile;
  }

  _requireAdmin(profile, accountId) {
    const acc = (profile.accounts || []).find((a) => Number(a.id) === Number(accountId));
    if (!acc || acc.role !== 'administrator') {
      throw new HttpError(403, 'Solo un administrador de esta cuenta puede conectar un número de WhatsApp.', 'forbidden');
    }
  }

  // ---------- aprovisionar ----------

  async provision({ devise, accountId, inboxName, phone, record, method }) {
    const acct = Number(accountId);
    if (!Number.isInteger(acct) || acct <= 0) throw new HttpError(400, 'Cuenta no válida.', 'bad_request');
    const name = sanitizeInboxName(inboxName);
    if (!name) throw new HttpError(400, 'Escribe un nombre para la bandeja.', 'bad_request');
    if (method !== 'qr' && method !== 'code') throw new HttpError(400, 'Método de emparejamiento no válido (usa "qr" o "code").', 'bad_request');
    let digits = null;
    if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
      digits = normalizePhone(phone);
      if (!digits) throw new HttpError(400, 'El número no es válido: usa solo dígitos con código de país (ej. 5215512345678).', 'bad_request');
    }
    if (method === 'code' && !digits) throw new HttpError(400, 'Para el código de 8 caracteres necesitas indicar tu número con código de país.', 'bad_request');

    // 1) Validar usuario: administrador de la cuenta
    const profile = await this._profile(devise);
    this._requireAdmin(profile, acct);
    const token = profile.access_token;
    if (!token) {
      throw new HttpError(409, 'Tu usuario no tiene token de API disponible. Pide que se habilite "API y webhooks" en la cuenta.', 'no_api_token');
    }

    // cupo: lista de cuentas habilitadas
    if (this.cfg.allowedAccountIds && !this.cfg.allowedAccountIds.has(acct)) {
      throw new HttpError(403, 'Esta cuenta no tiene habilitado WhatsApp + Llamadas. Contacta a soporte.', 'account_not_allowed');
    }
    // cupo: bandejas API de AstraCalls ya existentes en la cuenta
    const prefix = this.ac.publicUrl;
    const existing = (await this.cw.listInboxes(acct, token))
      .filter((i) => typeof i.webhook_url === 'string' && i.webhook_url.startsWith(prefix)).length;
    if (existing >= this.cfg.maxSessionsPerAccount) {
      throw new HttpError(409, 'Alcanzaste el límite de números de tu plan.', 'quota_reached');
    }

    // límite por cuenta por hora
    const t = this.now();
    const hist = (this.accountHistory.get(acct) || []).filter((x) => t - x < 3600000);
    if (hist.length >= this.cfg.provisionsPerAccountPerHour) {
      throw new HttpError(429, 'Se alcanzó el límite de intentos de esta cuenta. Inténtalo de nuevo más tarde.', 'rate_limited');
    }
    hist.push(t);
    this.accountHistory.set(acct, hist);

    const created = { sid: null, inboxId: null };
    let code = '';
    try {
      // 2) Sesión en AstraCalls
      created.sid = await this.ac.createSession(name);
      // 3) Bandeja API en Chatwoot con el webhook de esa sesión
      const inbox = await this.cw.createApiInbox(acct, token, { name, webhookUrl: this.ac.webhookUrlFor(created.sid) });
      created.inboxId = inbox.id;
      // 4) Configurar Chatwoot en AstraCalls (sin importar historial por defecto)
      await this.ac.setChatwoot(created.sid, {
        url: this.cfg.chatwootUrl,
        account_id: acct,
        account_token: token,
        inbox_id: inbox.id,
        inbox_identifier: inbox.identifier,
        import_history: false,
        import_history_days: 30,
      });
      // 5) Grabación
      if (record) await this.ac.setRecording(created.sid, true);
      // 6) Emparejamiento. AstraCalls ya arranca el QR al crear la sesión; para "code" se pide el código.
      if (method === 'code') code = await this.ac.pairCode(created.sid, digits);
    } catch (e) {
      const rolled = await this._rollback(acct, token, created);
      const base = e instanceof HttpError ? e : new HttpError(500, 'Error inesperado al configurar la conexión.', 'internal');
      this.log.warn('provision falló; revertido', { accountId: acct, step: base.code, rolledBack: rolled });
      const suffix = rolled ? ' Se revirtieron los cambios.' : ' No se pudieron revertir todos los cambios; avisa al administrador del sistema.';
      throw new HttpError(base.status, base.message + suffix, base.code);
    }

    const id = newId();
    const created_at = this.now();
    this.items.set(id, {
      id, ownerUid: profile.id, accountId: acct, sid: created.sid, inboxId: created.inboxId,
      method, code, record: !!record, phone: digits, token, createdAt: created_at,
      expiresAt: created_at + this.cfg.ttlMs, lastPair: created_at, connected: false, connectedPhone: '', cancelled: false,
    });
    this.log.info('provision creada', { provisionId: id, accountId: acct, inboxId: created.inboxId, method });
    return { provisionId: id };
  }

  async _rollback(accountId, token, created) {
    let ok = true;
    if (created.inboxId) {
      try { if (!(await this.cw.deleteInbox(accountId, token, created.inboxId))) ok = false; } catch { ok = false; }
    }
    if (created.sid) {
      try { await this.ac.deleteSession(created.sid); } catch { ok = false; }
    }
    return ok;
  }

  // ---------- estado ----------

  async _authorized(id, devise) {
    const item = this.items.get(id);
    if (!item) throw new HttpError(404, 'La solicitud no existe o ya expiró.', 'not_found');
    const profile = await this._profile(devise);
    if (profile.id !== item.ownerUid) throw new HttpError(404, 'La solicitud no existe o ya expiró.', 'not_found');
    this._requireAdmin(profile, item.accountId);
    return item;
  }

  async status(id, devise) {
    const item = await this._authorized(id, devise);
    const base = { inboxId: item.inboxId, accountId: item.accountId };
    if (item.cancelled) return { state: 'cancelled', ...base };
    if (this.now() > item.expiresAt && !item.connected) return { state: 'expired', ...base };
    if (item.connected) return { state: 'connected', connectedPhone: item.connectedPhone, ...base };

    const auth = await this.ac.getAuth(item.sid);
    if (auth.paired && (auth.state === 'open' || auth.state === undefined)) {
      item.connected = true;
      item.connectedPhone = String(auth.jid || '').split(/[:@]/)[0] || '';
      item.token = null; // ya no se necesita para revertir
      this.log.info('provision conectada', { provisionId: id, accountId: item.accountId });
      return { state: 'connected', connectedPhone: item.connectedPhone, ...base };
    }

    if (item.method === 'code') {
      const code = (auth.code && auth.state === 'pairing_code') ? auth.code : item.code;
      return { state: 'code', code, ...base };
    }

    // QR: si aún no hay o el QR caducó (logged_out), pedir uno nuevo con límite de frecuencia
    const t = this.now();
    const stale = !auth.qr && (auth.state === 'logged_out' || t - item.createdAt > QR_GRACE_MS);
    if (stale && t - item.lastPair > REPAIR_MIN_INTERVAL_MS) {
      item.lastPair = t;
      try { await this.ac.pair(item.sid); } catch { /* se reintenta luego */ }
    }
    if (auth.qr) return { state: 'qr', qr: auth.qr, ...base };
    return { state: 'starting', ...base };
  }

  /** Cancela y revierte si todavía no está conectada. */
  async cancel(id, devise) {
    const item = await this._authorized(id, devise);
    if (item.connected) return { state: 'connected', inboxId: item.inboxId, accountId: item.accountId };
    await this._discard(item);
    return { state: 'cancelled', inboxId: item.inboxId, accountId: item.accountId };
  }

  async _discard(item) {
    item.cancelled = true;
    const token = item.token;
    item.token = null;
    const rolled = await this._rollback(item.accountId, token, { sid: item.sid, inboxId: item.inboxId });
    this.log.info('provision descartada', { provisionId: item.id, accountId: item.accountId, rolledBack: rolled });
  }

  /** Expira (>15 min) y limpia; revierte lo no conectado. */
  async sweep() {
    const t = this.now();
    for (const [id, item] of [...this.items]) {
      if (t <= item.expiresAt + 60000) continue;
      if (!item.connected && !item.cancelled) await this._discard(item);
      this.items.delete(id);
    }
    for (const [k, v] of [...this.profileCache]) if (t - v.at > PROFILE_CACHE_MS) this.profileCache.delete(k);
    for (const [k, v] of [...this.accountHistory]) {
      const f = v.filter((x) => t - x < 3600000);
      if (f.length) this.accountHistory.set(k, f); else this.accountHistory.delete(k);
    }
  }
}

module.exports = { Provisioner };
