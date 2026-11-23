'use strict';

const crypto = require('node:crypto');

/** Error con código HTTP y mensaje seguro (en español) para el cliente. */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

/** Teléfono: solo dígitos con código de país (8 a 15 dígitos, E.164 sin '+'). Acepta '+' y espacios al inicio. */
function normalizePhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\+?[\d\s\-()]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  return digits;
}

/** Sanea el nombre de la bandeja: sin caracteres de control ni marcado, 1..60 caracteres. */
function sanitizeInboxName(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '');
  s = s.replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 60) s = s.slice(0, 60).trim();
  return s;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function newId() {
  return crypto.randomBytes(18).toString('base64url');
}

/** Extrae y valida los headers devise de la petición. Devuelve null si faltan. */
function deviseFromReq(req) {
  const at = req.get('access-token');
  const client = req.get('client');
  const uid = req.get('uid');
  if (!at || !client || !uid) return null;
  if (at.length > 256 || client.length > 256 || uid.length > 320) return null;
  return { 'access-token': at, client, uid };
}

/** Logger que NUNCA recibe tokens: solo mensajes y metadatos no sensibles. */
function makeLogger(out = console) {
  const fmt = (lvl, msg, meta) => {
    const m = meta ? ' ' + JSON.stringify(meta) : '';
    out.log(`${new Date().toISOString()} ${lvl} ${msg}${m}`);
  };
  return {
    info: (m, meta) => fmt('INFO', m, meta),
    warn: (m, meta) => fmt('WARN', m, meta),
    error: (m, meta) => fmt('ERROR', m, meta),
  };
}

/** fetch con timeout; lanza Error('timeout') si se agota. */
async function fetchT(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error('timeout');
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { HttpError, normalizePhone, sanitizeInboxName, sha256, newId, deviseFromReq, makeLogger, fetchT };
