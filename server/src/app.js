'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError, deviseFromReq } = require('./util');
const pkg = require('../package.json');

/**
 * Versión que corre: la etiqueta de la imagen (CI pasa APP_VERSION) o, si se
 * construyó desde el repo (ej. Coolify), la de package.json. El commit sale de
 * GIT_SHA (CI) o SOURCE_COMMIT (Coolify, si "Include Source Commit in Build").
 */
const BUILD = {
  version: process.env.APP_VERSION || 'prov-v' + pkg.version,
  commit: String(process.env.GIT_SHA || process.env.SOURCE_COMMIT || '').slice(0, 7) || undefined,
};

/** Limitador de ventana deslizante en memoria. */
function makeLimiter(max, windowMs, now = () => Date.now()) {
  const hits = new Map();
  const timer = setInterval(() => {
    const t = now();
    for (const [k, arr] of hits) {
      const f = arr.filter((x) => t - x < windowMs);
      if (f.length) hits.set(k, f); else hits.delete(k);
    }
  }, windowMs);
  if (timer.unref) timer.unref();
  const check = (key) => {
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(t);
    hits.set(key, arr);
    return true;
  };
  check.close = () => clearInterval(timer);
  return check;
}

function createApp({ cfg, provisioner, log, capiSender }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  const limIpProvision = makeLimiter(cfg.rateIpPerMin, 60000);
  const limAccProvision = makeLimiter(cfg.rateAccountPerMin, 60000);
  const limIpStatus = makeLimiter(cfg.rateIpPerMin * 12, 60000);
  const limIdStatus = makeLimiter(90, 60000);
  const limIpWrite = makeLimiter(cfg.rateIpPerMin * 2, 60000);

  // Cabeceras de seguridad básicas
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Script estático (cargado con <script src>, no requiere CORS)
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '5m',
    index: false,
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache'); // revalida con ETag: los cambios llegan al recargar
      }
      if (filePath.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      }
    },
  }));

  app.get('/healthz', (req, res) => res.json({ ok: true, ...BUILD }));

  // Webhook de la cuenta de Chatwoot para CAPI (sin CORS: lo llama Chatwoot).
  // El secreto va en la ruta; se responde enseguida y se procesa aparte.
  const limHook = makeLimiter(600, 60000);
  app.post('/capi/hook/:acct/:secret', express.json({ limit: '1mb' }), (req, res) => {
    if (!limHook(req.params.acct)) return res.status(429).end();
    res.status(204).end();
    if (!capiSender) return;
    capiSender.handle(Number(req.params.acct), req.params.secret, req.body)
      .catch((e) => log.error('capi: error al procesar webhook', { message: e && e.message }));
  });

  // CORS estricto: solo el origen de Chatwoot
  const api = express.Router();
  api.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      if (origin !== cfg.allowedOrigin) return res.status(403).json({ error: 'Origen no permitido.', code: 'cors' });
      res.setHeader('Access-Control-Allow-Origin', cfg.allowedOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, access-token, client, uid');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  api.use(express.json({ limit: '4kb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const needDevise = (req) => {
    const d = deviseFromReq(req);
    if (!d) throw new HttpError(401, 'Falta la sesión de Chatwoot. Recarga la página e inicia sesión de nuevo.', 'session_missing');
    return d;
  };

  api.post('/provision', wrap(async (req, res) => {
    if (!limIpProvision(req.ip)) throw new HttpError(429, 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.', 'rate_limited');
    const devise = needDevise(req);
    const b = req.body || {};
    if (!limAccProvision(String(b.accountId))) throw new HttpError(429, 'Demasiados intentos para esta cuenta. Espera un minuto.', 'rate_limited');
    const out = await provisioner.provision({
      devise, accountId: b.accountId, inboxName: b.inboxName, phone: b.phone, record: b.record === true, method: b.method,
      importHistory: b.importHistory === true, importHistoryDays: b.importHistoryDays, mirrorApi: b.mirrorApi === true,
      deviceMode: typeof b.deviceMode === 'string' ? b.deviceMode : undefined,
      existingInboxId: b.existingInboxId,
      recoverSessionId: b.recoverSessionId,
    });
    res.status(201).json(out);
  }));

  // bandejas API de la cuenta que se pueden conectar (conservan su historial)
  api.get('/inbox/available', wrap(async (req, res) => {
    if (!limIpStatus(req.ip)) throw new HttpError(429, 'Demasiadas consultas. Espera unos segundos.', 'rate_limited');
    const devise = needDevise(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await provisioner.availableInboxes(devise, req.query.accountId));
  }));

  // números desvinculados de la cuenta que se pueden recuperar (24 h desde que se borró su bandeja)
  api.get('/inbox/recoverable', wrap(async (req, res) => {
    if (!limIpStatus(req.ip)) throw new HttpError(429, 'Demasiadas consultas. Espera unos segundos.', 'rate_limited');
    const devise = needDevise(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await provisioner.recoverableNumbers(devise, req.query.accountId));
  }));

  // ---- configuración de una bandeja ya conectada ----
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const readLimit = (req) => { if (!limIpStatus(req.ip)) throw new HttpError(429, 'Demasiadas consultas. Espera unos segundos.', 'rate_limited'); };
  const writeLimit = (req) => { if (!limIpWrite(req.ip)) throw new HttpError(429, 'Demasiados cambios seguidos. Espera un minuto.', 'rate_limited'); };

  api.get('/inbox/settings', wrap(async (req, res) => {
    readLimit(req);
    const devise = needDevise(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await provisioner.inboxSettings(devise, req.query.accountId, req.query.inboxId));
  }));

  api.put('/inbox/settings', wrap(async (req, res) => {
    writeLimit(req);
    const devise = needDevise(req);
    const b = req.body || {};
    res.setHeader('Cache-Control', 'no-store');
    res.json(await provisioner.updateInboxSettings(devise, {
      accountId: b.accountId, inboxId: b.inboxId,
      recording: bool(b.recording), mirrorApi: bool(b.mirrorApi), importHistory: bool(b.importHistory),
      deviceMode: typeof b.deviceMode === 'string' ? b.deviceMode : undefined, readReceipts: bool(b.readReceipts),
      contactDelete: typeof b.contactDelete === 'string' ? b.contactDelete : undefined,
      conversationStatus: typeof b.conversationStatus === 'string' ? b.conversationStatus : undefined,
      archiveSync: typeof b.archiveSync === 'string' ? b.archiveSync : undefined,
      readMessages: bool(b.readMessages), alwaysOnline: bool(b.alwaysOnline),
      importHistoryDays: b.importHistoryDays,
    }));
  }));

  // ---- integración "Meta · API de conversiones" (cuenta) ----
  api.get('/account/capi', wrap(async (req, res) => {
    const devise = needDevise(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await provisioner.capiStatus(devise, req.query.accountId));
  }));

  api.post('/account/capi', wrap(async (req, res) => {
    writeLimit(req);
    const devise = needDevise(req);
    res.setHeader('Cache-Control', 'no-store');
    const b = req.body || {};
    res.json(await provisioner.enableCapi(devise, b.accountId, b.extras));
  }));

  api.post('/account/capi/meta', wrap(async (req, res) => {
    writeLimit(req);
    const devise = needDevise(req);
    res.setHeader('Cache-Control', 'no-store');
    const b = req.body || {};
    res.json(await provisioner.saveCapiMeta(devise, b.accountId, b, `${req.protocol}://${req.get('host')}`));
  }));

  // ---- llaves MCP de la bandeja (conectar una IA a ese número) ----
  api.get('/inbox/mcp-keys', wrap(async (req, res) => {
    readLimit(req);
    const devise = needDevise(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await provisioner.listMcpKeys(devise, req.query.accountId, req.query.inboxId));
  }));

  api.post('/inbox/mcp-keys', wrap(async (req, res) => {
    writeLimit(req);
    const devise = needDevise(req);
    const b = req.body || {};
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(await provisioner.createMcpKey(devise, { accountId: b.accountId, inboxId: b.inboxId, name: b.name, readOnly: b.readOnly === true }));
  }));

  // Revocar llaves MCP NO está expuesto a los clientes: lo hace el administrador en el panel de AstraCalls.

  api.get('/provision/:id/status', wrap(async (req, res) => {
    if (!limIpStatus(req.ip) || !limIdStatus(req.params.id)) throw new HttpError(429, 'Demasiadas consultas. Espera unos segundos.', 'rate_limited');
    const devise = needDevise(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await provisioner.status(req.params.id, devise));
  }));

  api.delete('/provision/:id', wrap(async (req, res) => {
    if (!limIpStatus(req.ip)) throw new HttpError(429, 'Demasiadas solicitudes.', 'rate_limited');
    const devise = needDevise(req);
    res.json(await provisioner.cancel(req.params.id, devise));
  }));

  app.use(api);

  // Errores: mensajes seguros en español, sin detalles internos
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      return res.status(400).json({ error: 'La solicitud no es válida.', code: 'bad_request' });
    }
    log.error('error no controlado', { message: err && err.message });
    res.status(500).json({ error: 'Error interno del servidor.', code: 'internal' });
  });

  app.close = () => [limIpProvision, limAccProvision, limIpStatus, limIdStatus, limIpWrite, limHook].forEach((l) => l.close());
  return app;
}

module.exports = { createApp, makeLimiter };
