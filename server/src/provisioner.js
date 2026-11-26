'use strict';

const { HttpError, normalizePhone, sanitizeInboxName, sha256, newId } = require('./util');
const { cleanCapiFields, SENT_ATTR } = require('./capi');

/** Días de historial permitidos en la UI: 7, 30 o 90 (por defecto 30). */
function clampDays(v) {
  const n = Number(v);
  return [7, 30, 90].includes(n) ? n : 30;
}

function hostOf(u) {
  try { return new URL(String(u)).host.toLowerCase(); } catch { return ''; }
}

/** Lo escrito desde el celular: mensaje que abre la conversación, mensaje sin cambiar el estado, o nota privada. */
const DEVICE_MODES = ['open', 'keep', 'note'];
// cuando el cliente elimina un mensaje: conservar con nota (defecto) o eliminar
const CONTACT_DELETE = ['note', 'delete'];
// estado con que AstraCalls crea las conversaciones nuevas (pending = Captain atiende primero)
const CONV_STATUS = ['open', 'pending'];
// espejo archivar (WhatsApp) <-> resolver (Chatwoot): desactivado, resuelta o pendiente
const ARCHIVE_SYNC = ['off', 'resolved', 'pending'];
// atributos de conversación con los datos del anuncio (para CAPI). Son de la CUENTA:
// se crean desde la tarjeta "Meta · API de conversiones" en Integraciones, y
// AstraCalls los llena en cualquier bandeja de la cuenta si existen.
// Los "required" son los que usa CAPI; los demás son opcionales (ya están en la
// nota y en el primer mensaje) y se crean solo si el administrador los marca.
const AD_ATTRIBUTES = [
  { key: 'ctwa_clid', required: true, name: 'Anuncio · Click ID', type: 'text', description: 'Click ID del anuncio de WhatsApp (ctwa_clid), para la API de conversiones de Meta' },
  { key: 'meta_ad_id', required: true, name: 'Anuncio · ID', type: 'text', description: 'ID del anuncio por el que llegó el contacto' },
  { key: 'monto', required: true, name: 'Monto de la venta', type: 'number', description: 'Lo llena el equipo al cerrar la venta; es el valor que se le envía a Meta' },
  { key: 'anuncio_titulo', name: 'Anuncio · Título', type: 'text', description: 'Título del anuncio' },
  { key: 'anuncio_origen', name: 'Anuncio · Origen', type: 'text', description: 'Origen del anuncio (ej. FB_Ads)' },
  { key: 'anuncio_enlace', name: 'Anuncio · Enlace', type: 'link', description: 'Enlace del anuncio' },
];
// marca que pone el provisioner cuando ya avisó la venta a Meta (evita reenviarla)
const SENT_ATTR_DEF = { key: SENT_ATTR, name: 'Meta · Venta enviada', type: 'text', description: 'Fecha y monto de la venta avisada a Meta. Bórralo y vuelve a poner la etiqueta para reenviarla.' };
/** Agent Bot de la cuenta con el que AstraCalls publica lo escrito desde el celular. */
const DEVICE_BOT = { name: 'WhatsApp (celular)', description: 'Mensajes escritos desde el celular conectado a WhatsApp + Llamadas.' };
const DEVICE_TITLE = '📱 Enviado desde el celular';

const PROFILE_CACHE_MS = 15000;
const REPAIR_MIN_INTERVAL_MS = 20000;
const QR_GRACE_MS = 8000;

class Provisioner {
  /**
   * @param {object} deps { cfg, chatwoot, astracalls, log, now? }
   */
  constructor({ cfg, chatwoot, astracalls, log, now, capiStore, capiSender, evolution }) {
    this.cfg = cfg;
    this.evo = evolution && evolution.enabled ? evolution : null;
    this.capiStore = capiStore || null;
    this.capiSender = capiSender || null;
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

  /** Token del bot "WhatsApp (celular)" de la cuenta (lo crea si falta). Best-effort: null si no se pudo. */
  async _deviceBotToken(accountId, token) {
    try {
      return await this.cw.ensureAgentBot(accountId, token, DEVICE_BOT);
    } catch {
      return null;
    }
  }

  /** ¿La bandeja es de tipo API y su webhook ya apunta a este AstraCalls? */
  _isApiInbox(i) {
    return !!i && i.channel_type === 'Channel::Api';
  }

  /** Instancia de Evolution de la bandeja (por su webhook), o null. */
  _evoInstance(webhookUrl) {
    return this.evo ? this.evo.instanceFromWebhook(webhookUrl) : null;
  }

  _isAstraInbox(i) {
    return !!i && typeof i.webhook_url === 'string' && i.webhook_url.startsWith(this.ac.publicUrl);
  }

  /**
   * Bandejas de tipo API de la cuenta que todavía no están conectadas a este
   * AstraCalls (por ejemplo, una que usaba otro conector de WhatsApp). Se
   * pueden conectar conservando su historial, agentes y automatizaciones.
   */
  async availableInboxes(devise, accountId) {
    const { acct, token } = await this._adminToken(devise, accountId);
    if (!token) throw new HttpError(409, 'Tu usuario no tiene token de API disponible. Pide que se habilite "API y webhooks" en la cuenta.', 'no_api_token');
    const list = await this.cw.listInboxes(acct, token);
    return {
      inboxes: list
        .filter((i) => this._isApiInbox(i) && !this._isAstraInbox(i))
        // otherProvider: la bandeja viene de Evolution; al conectar, esa instancia se apaga
        .map((i) => ({ id: Number(i.id), name: String(i.name || ''), otherProvider: !!this._evoInstance(i.webhook_url) })),
    };
  }

  async provision({ devise, accountId, inboxName, phone, record, method, importHistory, importHistoryDays, mirrorApi, deviceMode, existingInboxId }) {
    const histDays = clampDays(importHistoryDays);
    const acct = Number(accountId);
    if (!Number.isInteger(acct) || acct <= 0) throw new HttpError(400, 'Cuenta no válida.', 'bad_request');
    let existingId = null;
    if (existingInboxId !== undefined && existingInboxId !== null && existingInboxId !== '') {
      existingId = Number(existingInboxId);
      if (!Number.isInteger(existingId) || existingId <= 0) throw new HttpError(400, 'Bandeja no válida.', 'bad_request');
    }
    let name = sanitizeInboxName(inboxName);
    if (!name && !existingId) throw new HttpError(400, 'Escribe un nombre para la bandeja.', 'bad_request');
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
    const existing = (await this.cw.listInboxes(acct, token)).filter((i) => this._isAstraInbox(i)).length;
    if (existing >= this.cfg.maxSessionsPerAccount) {
      throw new HttpError(409, 'Alcanzaste el límite de números de tu plan.', 'quota_reached');
    }

    // límite por cuenta por hora
    const t = this.now();
    const hist = (this.accountHistory.get(acct) || []).filter((x) => t - x < 3600000);
    if (hist.length >= this.cfg.provisionsPerAccountPerHour) {
      throw new HttpError(429, 'Se alcanzó el límite de intentos de esta cuenta. Inténtalo de nuevo más tarde.', 'rate_limited');
    }
    // bandeja existente: debe ser de esta cuenta, de tipo API y no estar ya conectada
    let reuse = null;
    if (existingId) {
      const ib = await this.cw.getInbox(acct, token, existingId);
      if (!ib) throw new HttpError(404, 'La bandeja no existe en esta cuenta.', 'inbox_not_found');
      if (!this._isApiInbox(ib)) throw new HttpError(400, 'Solo se pueden conectar bandejas de tipo API.', 'inbox_not_api');
      if (this._isAstraInbox(ib)) throw new HttpError(409, 'Esa bandeja ya está conectada a WhatsApp + Llamadas.', 'inbox_already_managed');
      reuse = {
        id: existingId,
        identifier: ib.inbox_identifier || ib.identifier || '',
        prevWebhook: typeof ib.webhook_url === 'string' ? ib.webhook_url : '',
        evoInstance: this._evoInstance(ib.webhook_url),
      };
      name = sanitizeInboxName(ib.name) || name || 'WhatsApp';
    }

    hist.push(t);
    this.accountHistory.set(acct, hist);

    const created = { sid: null, inboxId: null, reuse };
    let code = '';
    try {
      // 2) Sesión en AstraCalls
      created.sid = await this.ac.createSession(name);
      // 3) Bandeja API en Chatwoot con el webhook de esa sesión (o la existente, con el webhook cambiado)
      let inbox;
      if (reuse) {
        await this.cw.updateInboxWebhook(acct, token, reuse.id, this.ac.webhookUrlFor(created.sid));
        inbox = { id: reuse.id, identifier: reuse.identifier };
      } else {
        inbox = await this.cw.createApiInbox(acct, token, { name, webhookUrl: this.ac.webhookUrlFor(created.sid) });
      }
      created.inboxId = inbox.id;
      // 4) Configurar Chatwoot en AstraCalls (sin importar historial por defecto)
      const botToken = await this._deviceBotToken(acct, token);
      await this.ac.setChatwoot(created.sid, {
        url: this.cfg.chatwootUrl,
        account_id: acct,
        account_token: token,
        inbox_id: inbox.id,
        inbox_identifier: inbox.identifier,
        // el historial solo llega al vincular: hay que activarlo ANTES del emparejamiento
        // bandeja existente: su historial ya está en Chatwoot (importarlo lo duplicaría)
        import_history: !!importHistory && !reuse,
        import_history_days: histDays,
        mirror_api: !!mirrorApi,
        // fork de AstraCalls (rama lhcia): lo escrito desde el celular como mensaje
        // (publicado por el bot de la cuenta) y checks de entregado/leído. La imagen
        // oficial ignora estos campos.
        device_mode: DEVICE_MODES.includes(deviceMode) ? deviceMode : 'open',
        device_title: DEVICE_TITLE,
        ...(botToken ? { device_bot_token: botToken } : {}),
        read_receipts: true,
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
      id, ownerUid: profile.id, accountId: acct, sid: created.sid, inboxId: created.inboxId, reuse,
      method, code, record: !!record, phone: digits, token, createdAt: created_at,
      expiresAt: created_at + this.cfg.ttlMs, lastPair: created_at, connected: false, connectedPhone: '', cancelled: false,
    });
    this.log.info('provision creada', { provisionId: id, accountId: acct, inboxId: created.inboxId, method, existingInbox: !!reuse });
    return { provisionId: id };
  }

  async _rollback(accountId, token, created) {
    let ok = true;
    if (created.inboxId && created.reuse) {
      // bandeja existente: nunca se borra; se le devuelve su webhook anterior
      try { await this.cw.updateInboxWebhook(accountId, token, created.inboxId, created.reuse.prevWebhook); } catch { ok = false; }
    } else if (created.inboxId) {
      try { if (!(await this.cw.deleteInbox(accountId, token, created.inboxId))) ok = false; } catch { ok = false; }
    }
    if (created.sid) {
      try { await this.ac.deleteSession(created.sid); } catch { ok = false; }
    }
    return ok;
  }

  // ---------- bandejas ya conectadas (configuración y MCP) ----------

  /**
   * Resuelve la sesión de AstraCalls de una bandeja, verificando que:
   *  - el usuario es administrador de la cuenta,
   *  - el webhook de la bandeja apunta a una sesión de ESTE AstraCalls,
   *  - y esa sesión está configurada para ESA cuenta, ESA bandeja y ESTE Chatwoot
   *    (evita que alguien apunte su bandeja a la sesión de otro cliente).
   * Devuelve { sid } o lanza 404 si la bandeja no es de WhatsApp + Llamadas.
   */
  async _resolveInbox(devise, accountId, inboxId) {
    const acct = Number(accountId);
    const inbox = Number(inboxId);
    if (!Number.isInteger(acct) || acct <= 0 || !Number.isInteger(inbox) || inbox <= 0) {
      throw new HttpError(400, 'Cuenta o bandeja no válida.', 'bad_request');
    }
    const profile = await this._profile(devise);
    this._requireAdmin(profile, acct);
    const token = profile.access_token;
    if (!token) throw new HttpError(409, 'Tu usuario no tiene token de API disponible. Pide que se habilite "API y webhooks" en la cuenta.', 'no_api_token');

    const notManaged = () => new HttpError(404, 'Esta bandeja no está conectada a WhatsApp + Llamadas.', 'not_managed');
    const data = await this.cw.getInbox(acct, token, inbox);
    const webhook = data && typeof data.webhook_url === 'string' ? data.webhook_url : '';
    const prefix = this.ac.publicUrl + '/api/sessions/';
    if (!webhook.startsWith(prefix)) throw notManaged();
    const m = webhook.slice(prefix.length).match(/^([A-Za-z0-9_-]{1,64})\/chatwoot\/webhook$/);
    if (!m) throw notManaged();
    const sid = m[1];
    const cfg = await this.ac.getChatwootCfg(sid);
    const sameChatwoot = cfg && hostOf(cfg.url) === hostOf(this.cfg.chatwootUrl);
    if (!cfg || !sameChatwoot || Number(cfg.account_id) !== acct || Number(cfg.inbox_id) !== inbox) {
      this.log.warn('bandeja con webhook a una sesión que no le corresponde', { accountId: acct, inboxId: inbox });
      throw notManaged();
    }
    return { sid, cfg, acct, inbox, token };
  }

  async inboxSettings(devise, accountId, inboxId) {
    const { sid, cfg, acct, token } = await this._resolveInbox(devise, accountId, inboxId);
    return this._settingsView(sid, await this._upgradeDevice(sid, cfg, acct, token));
  }

  /**
   * Bandejas conectadas antes del bot del celular: al abrir su configuración se les
   * prepara el bot y el título en español (una sola vez; si falla, se reintenta la
   * próxima vez que se abra).
   */
  async _upgradeDevice(sid, cfg, acct, token) {
    if (cfg.device_bot) return cfg;
    const botToken = await this._deviceBotToken(acct, token);
    if (!botToken) return cfg;
    try {
      await this.ac.setChatwoot(sid, { device_bot_token: botToken, device_title: DEVICE_TITLE });
    } catch {
      return cfg;
    }
    this.log.info('bot del celular preparado en bandeja existente', { accountId: acct });
    return (await this.ac.getChatwootCfg(sid)) || cfg;
  }

  async _settingsView(sid, cfg) {
    const [recording, sessions] = await Promise.all([
      this.ac.getRecording(sid),
      this.ac.listSessions().catch(() => []),
    ]);
    const s = sessions.find((x) => x.id === sid) || {};
    return {
      managed: true,
      connected: !!s.paired && (s.state === 'open' || s.state === undefined),
      phone: String(s.jid || s.lastJid || '').split(/[:@]/)[0] || '',
      recording,
      mirrorApi: !!cfg.mirror_api,
      // AstraCalls trae ambos encendidos por defecto (campo ausente = encendido)
      deviceMode: DEVICE_MODES.includes(cfg.device_mode) ? cfg.device_mode : 'open',
      deviceBot: !!cfg.device_bot,
      readReceipts: cfg.read_receipts !== false,
      contactDelete: CONTACT_DELETE.includes(cfg.contact_delete) ? cfg.contact_delete : 'note',
      conversationStatus: CONV_STATUS.includes(cfg.conversation_status) ? cfg.conversation_status : 'open',
      archiveSync: ARCHIVE_SYNC.includes(cfg.archive_sync) ? cfg.archive_sync : 'off',
      readMessages: !!cfg.read_messages,
      alwaysOnline: !!cfg.always_online,
      importHistory: !!cfg.import_history,
      importHistoryDays: clampDays(cfg.import_history_days),
      mcpEndpoint: this.ac.mcpEndpoint(),
    };
  }

  async updateInboxSettings(devise, { accountId, inboxId, recording, mirrorApi, deviceMode, readReceipts, contactDelete, conversationStatus, archiveSync, readMessages, alwaysOnline, importHistory, importHistoryDays }) {
    const { sid } = await this._resolveInbox(devise, accountId, inboxId);
    if (deviceMode !== undefined && !DEVICE_MODES.includes(deviceMode)) {
      throw new HttpError(400, 'Opción no válida para lo escrito desde el celular.', 'bad_request');
    }
    if (contactDelete !== undefined && !CONTACT_DELETE.includes(contactDelete)) {
      throw new HttpError(400, 'Opción no válida para los mensajes eliminados.', 'bad_request');
    }
    if (conversationStatus !== undefined && !CONV_STATUS.includes(conversationStatus)) {
      throw new HttpError(400, 'Opción no válida para las conversaciones nuevas.', 'bad_request');
    }
    if (archiveSync !== undefined && !ARCHIVE_SYNC.includes(archiveSync)) {
      throw new HttpError(400, 'Opción no válida para archivar.', 'bad_request');
    }
    if (typeof recording === 'boolean') await this.ac.setRecording(sid, recording);
    const patch = {};
    if (typeof mirrorApi === 'boolean') patch.mirror_api = mirrorApi;
    if (deviceMode !== undefined) patch.device_mode = deviceMode;
    if (typeof readReceipts === 'boolean') patch.read_receipts = readReceipts;
    if (contactDelete !== undefined) patch.contact_delete = contactDelete;
    if (conversationStatus !== undefined) patch.conversation_status = conversationStatus;
    if (archiveSync !== undefined) patch.archive_sync = archiveSync;
    if (typeof readMessages === 'boolean') patch.read_messages = readMessages;
    if (typeof alwaysOnline === 'boolean') patch.always_online = alwaysOnline;
    if (typeof importHistory === 'boolean') patch.import_history = importHistory;
    if (importHistoryDays !== undefined) patch.import_history_days = clampDays(importHistoryDays);
    // AstraCalls conserva lo que no viene en el payload (y el token si va vacío)
    if (Object.keys(patch).length) await this.ac.setChatwoot(sid, patch);
    this.log.info('configuración de bandeja actualizada', { accountId: Number(accountId), inboxId: Number(inboxId), fields: Object.keys(patch).concat(typeof recording === 'boolean' ? ['recording'] : []) });
    const cfg = await this.ac.getChatwootCfg(sid);
    return this._settingsView(sid, cfg || {});
  }

  // ---------- integración "Meta · API de conversiones" (cuenta) ----------

  async _adminToken(devise, accountId) {
    const acct = Number(accountId);
    if (!Number.isInteger(acct) || acct <= 0) throw new HttpError(400, 'Cuenta no válida.', 'bad_request');
    const profile = await this._profile(devise);
    this._requireAdmin(profile, acct);
    return { acct, token: profile.access_token };
  }

  /** Estado: activado si la cuenta tiene todos los atributos del anuncio. */
  async capiStatus(devise, accountId) {
    const { acct, token } = await this._adminToken(devise, accountId);
    const have = await this.cw.conversationAttributeKeys(acct, token);
    if (!have) throw new HttpError(502, 'No se pudo leer la configuración de Chatwoot. Intenta de nuevo.', 'chatwoot_error');
    return this._capiView(have, acct);
  }

  /** Crea en la cuenta los atributos del anuncio que falten: los de CAPI y los opcionales marcados. */
  async enableCapi(devise, accountId, extras) {
    const { acct, token } = await this._adminToken(devise, accountId);
    const wanted = new Set(Array.isArray(extras) ? extras.map(String) : []);
    const defs = AD_ATTRIBUTES.filter((d) => d.required || wanted.has(d.key));
    let ok = false;
    try { ok = await this.cw.ensureConversationAttributes(acct, token, defs); } catch { ok = false; }
    if (!ok) throw new HttpError(502, 'No se pudieron crear los atributos del anuncio en Chatwoot. Intenta de nuevo.', 'chatwoot_error');
    this.log.info('atributos de anuncio creados', { accountId: acct });
    return this._capiView(await this.cw.conversationAttributeKeys(acct, token) || new Set(defs.map((d) => d.key)), acct);
  }

  _capiView(have, accountId) {
    const attributes = AD_ATTRIBUTES.map((d) => ({ key: d.key, name: d.name, required: !!d.required, present: have.has(d.key) }));
    const store = this.capiStore;
    return {
      enabled: attributes.filter((a) => a.required).every((a) => a.present),
      attributes,
      meta: {
        available: !!(store && store.ready),
        config: store && accountId ? store.view(accountId) : null,
      },
    };
  }

  /**
   * Guarda la conexión con Meta de la cuenta: valida el token contra el dataset,
   * lo guarda cifrado, crea el atributo capi_enviado y el webhook de la cuenta
   * que avisa al provisioner cuando cambia una conversación.
   */
  async saveCapiMeta(devise, accountId, body, publicBase) {
    const { acct, token } = await this._adminToken(devise, accountId);
    const store = this.capiStore;
    if (!store || !store.ready || !this.capiSender) throw new HttpError(503, 'Falta configurar el servidor (CAPI_SECRET). Avisa a soporte.', 'capi_unavailable');
    const base = this.cfg.publicUrl || publicBase;
    if (!base) throw new HttpError(503, 'Falta la dirección pública del servidor (PUBLIC_URL). Avisa a soporte.', 'capi_unavailable');
    const prev = store.get(acct);
    const { fields, error } = cleanCapiFields(body || {}, { hasToken: !!(prev && prev.metaToken) });
    if (error) throw new HttpError(400, error, 'bad_request');
    const metaToken = fields.metaToken || prev.metaToken;
    let datasetName = '';
    try { datasetName = await this.capiSender.verifyDataset(fields.datasetId, metaToken); } catch (e) { throw new HttpError(400, e.message, 'meta_rejected'); }
    let ok = false;
    try { ok = await this.cw.ensureConversationAttributes(acct, token, [SENT_ATTR_DEF]); } catch { ok = false; }
    if (!ok) throw new HttpError(502, 'No se pudo crear el atributo "Meta · Venta enviada" en Chatwoot. Intenta de nuevo.', 'chatwoot_error');
    const rec = store.set(acct, { ...fields, datasetName, cwToken: token });
    const prefix = `${base}/capi/hook/${acct}/`;
    let hook = false;
    try {
      hook = await this.cw.ensureAccountWebhook(acct, token, { url: prefix + rec.hookSecret, prefix, subscriptions: ['conversation_updated'] });
    } catch { hook = false; }
    if (!hook) throw new HttpError(502, 'Se guardaron los datos, pero no se pudo crear el webhook en Chatwoot. Intenta de nuevo.', 'chatwoot_error');
    this.log.info('conexión con Meta guardada', { accountId: acct, test: !!fields.testEventCode });
    const have = await this.cw.conversationAttributeKeys(acct, token) || new Set();
    return this._capiView(have, acct);
  }

  async listMcpKeys(devise, accountId, inboxId) {
    const { sid } = await this._resolveInbox(devise, accountId, inboxId);
    const { keys } = await this.ac.listMcpKeys(sid);
    return {
      endpoint: this.ac.mcpEndpoint(),
      max: this.cfg.mcpKeysPerInbox,
      keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, readOnly: !!k.readOnly, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null })),
    };
  }

  async createMcpKey(devise, { accountId, inboxId, name, readOnly }) {
    const { sid } = await this._resolveInbox(devise, accountId, inboxId);
    // cupo de llaves por bandeja (por defecto 1). El cliente no puede revocar desde
    // Chatwoot: si la pierde, el administrador la revoca en el panel de AstraCalls.
    const { keys } = await this.ac.listMcpKeys(sid);
    if (keys.length >= this.cfg.mcpKeysPerInbox) {
      throw new HttpError(409, 'Esta bandeja ya tiene su llave de IA. Si la perdiste o crees que se filtró, contacta a soporte para revocarla.', 'mcp_key_limit');
    }
    const clean = sanitizeInboxName(name) || 'Mi IA';
    const r = await this.ac.createMcpKey(sid, clean, !!readOnly);
    const endpoint = this.ac.mcpEndpoint();
    this.log.info('llave MCP creada', { accountId: Number(accountId), inboxId: Number(inboxId), readOnly: !!readOnly });
    return {
      key: { id: r.key && r.key.id, name: clean, prefix: r.key && r.key.prefix, readOnly: !!readOnly },
      secret: r.secret, // se muestra una sola vez; nunca se registra
      endpoint,
      url: `${endpoint}/${r.secret}`,
    };
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
      if (item.reuse && item.reuse.evoInstance) this._shutdownEvolution(item);
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

  /**
   * La bandeja venía de Evolution y el número ya quedó vinculado en AstraCalls:
   * se cierra la sesión de esa instancia en Evolution (no se borra) para que los
   * mensajes no entren dos veces. Solo después de conectar: si el QR falla o se
   * cancela, Evolution sigue funcionando.
   */
  _shutdownEvolution(item) {
    const instance = item.reuse.evoInstance;
    item.reuse.evoInstance = null; // una sola vez
    this.evo.logout(instance).then((ok) => {
      if (ok) this.log.info('instancia de Evolution apagada', { accountId: item.accountId, inboxId: item.inboxId });
      else this.log.warn('no se pudo apagar la instancia de Evolution; apágala a mano', { accountId: item.accountId, inboxId: item.inboxId });
    });
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
    const rolled = await this._rollback(item.accountId, token, { sid: item.sid, inboxId: item.inboxId, reuse: item.reuse });
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
