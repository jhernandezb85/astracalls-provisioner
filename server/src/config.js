'use strict';

function trimSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

function load(env = process.env) {
  const cfg = {
    port: Number(env.PORT || 3000),
    astracallsUrl: trimSlash(env.ASTRACALLS_URL || 'http://host.docker.internal:8091'),
    astracallsApiKey: env.ASTRACALLS_API_KEY || '',
    astracallsPublicUrl: trimSlash(env.ASTRACALLS_PUBLIC_URL),
    chatwootUrl: trimSlash(env.CHATWOOT_URL),
    allowedOrigin: trimSlash(env.ALLOWED_ORIGIN),
    httpTimeoutMs: Number(env.HTTP_TIMEOUT_MS || 15000),
    ttlMs: Number(env.PROVISION_TTL_MS || 15 * 60 * 1000),
    rateIpPerMin: Number(env.RATE_IP_PER_MIN || 20),
    rateAccountPerMin: Number(env.RATE_ACCOUNT_PER_MIN || 10),
    provisionsPerAccountPerHour: Number(env.PROVISIONS_PER_ACCOUNT_PER_HOUR || 10),
    allowedAccountIds: env.ALLOWED_ACCOUNT_IDS && env.ALLOWED_ACCOUNT_IDS.trim()
      ? new Set(env.ALLOWED_ACCOUNT_IDS.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))
      : null,
    maxSessionsPerAccount: env.MAX_SESSIONS_PER_ACCOUNT === undefined || env.MAX_SESSIONS_PER_ACCOUNT === '' ? 1 : Number(env.MAX_SESSIONS_PER_ACCOUNT),
    trustProxy: env.TRUST_PROXY === undefined ? 1 : Number(env.TRUST_PROXY),
  };
  return cfg;
}

function validate(cfg) {
  const missing = [];
  if (!cfg.astracallsApiKey) missing.push('ASTRACALLS_API_KEY');
  if (!cfg.astracallsPublicUrl) missing.push('ASTRACALLS_PUBLIC_URL');
  if (!cfg.chatwootUrl) missing.push('CHATWOOT_URL');
  if (!cfg.allowedOrigin) missing.push('ALLOWED_ORIGIN');
  if (missing.length) {
    throw new Error('Faltan variables de entorno obligatorias: ' + missing.join(', '));
  }
}

module.exports = { load, validate };
