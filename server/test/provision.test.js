'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, DEVISE, USER_TOKEN, SECRET_API_KEY } = require('./helpers');
const { normalizePhone, sanitizeInboxName } = require('../src/util');

const BODY = { accountId: 7, inboxName: 'Ventas', phone: '+52 55 1234 5678', record: true, method: 'qr' };
const ops = (ac) => ac.state.calls.map((c) => c.op);

test('validación de teléfono y nombre', () => {
  assert.equal(normalizePhone('+52 55 1234 5678'), '525512345678');
  assert.equal(normalizePhone('5215512345678'), '5215512345678');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('abc5215512345678'), null);
  assert.equal(normalizePhone('0525512345678'), null);
  assert.equal(normalizePhone('1234567890123456'), null);
  assert.equal(sanitizeInboxName('  <b>Ventas</b>\u0000 "MX"  '), 'bVentas/b MX');
  assert.equal(sanitizeInboxName('x'.repeat(100)).length, 60);
  assert.equal(sanitizeInboxName('<>'), '');
});

test('flujo feliz (QR): orden de pasos, webhook y config de Chatwoot', async () => {
  const s = await setup();
  try {
    const r = await s.call('POST', '/provision', { body: BODY });
    assert.equal(r.status, 201);
    assert.ok(r.json.provisionId);

    assert.deepEqual(ops(s.ac), ['createSession', 'setChatwoot', 'setRecording']);
    const inbox = [...s.cw.state.inboxes.values()][0];
    assert.equal(inbox.channel.type, 'api');
    assert.equal(inbox.channel.webhook_url, 'https://calls.example.com/api/sessions/sess1/chatwoot/webhook');
    const cfg = s.ac.state.calls.find((c) => c.op === 'setChatwoot').body;
    assert.equal(cfg.account_token, USER_TOKEN);
    assert.equal(cfg.account_id, 7);
    assert.equal(cfg.inbox_id, 100);
    assert.equal(cfg.inbox_identifier, 'ident-100');
    assert.equal(cfg.import_history, false);
    assert.equal(cfg.url, s.cfg.chatwootUrl);
    assert.deepEqual(s.ac.state.calls.find((c) => c.op === 'setRecording').body, { enabled: true });
    assert.equal(s.ac.state.calls[0].body.name, 'Ventas');

    // estado: sin QR todavía
    let st = await s.call('GET', `/provision/${r.json.provisionId}/status`);
    assert.equal(st.json.state, 'starting');
    assert.equal(st.json.inboxId, 100);
    // llega el QR por SSE
    s.astracalls._onEvent({ type: 'session-qr', sessionId: 'sess1', qr: '2@abc,def,ghi' });
    st = await s.call('GET', `/provision/${r.json.provisionId}/status`);
    assert.equal(st.json.state, 'qr');
    assert.equal(st.json.qr, '2@abc,def,ghi');
    // se empareja
    s.astracalls._onEvent({ type: 'auth-state', sessionId: 'sess1', state: 'open', paired: true, qr: '' });
    s.astracalls._onEvent({ type: 'session-list', sessions: [{ id: 'sess1', state: 'open', paired: true, jid: '525512345678:12@s.whatsapp.net' }] });
    st = await s.call('GET', `/provision/${r.json.provisionId}/status`);
    assert.equal(st.json.state, 'connected');
    assert.equal(st.json.connectedPhone, '525512345678');
  } finally { await s.close(); }
});

test('flujo feliz (código de 8 caracteres)', async () => {
  const s = await setup();
  try {
    const r = await s.call('POST', '/provision', { body: { ...BODY, record: false, method: 'code' } });
    assert.equal(r.status, 201);
    assert.deepEqual(ops(s.ac), ['createSession', 'setChatwoot', 'pairCode']); // sin grabación
    assert.equal(s.ac.state.calls.find((c) => c.op === 'pairCode').body.phone, '525512345678');
    const st = await s.call('GET', `/provision/${r.json.provisionId}/status`);
    assert.equal(st.json.state, 'code');
    assert.equal(st.json.code, 'ABCD1234');
  } finally { await s.close(); }
});

test('usuario que no es administrador recibe 403 y no se toca nada', async () => {
  const s = await setup({ cwOpts: { users: { 'admin@example.com': { id: 2, role: 'agent', accountId: 7, token: USER_TOKEN } } } });
  try {
    const r = await s.call('POST', '/provision', { body: BODY });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /administrador/);
    assert.equal(s.ac.state.calls.length, 0);
    assert.equal(s.cw.state.inboxes.size, 0);
    // administrador de OTRA cuenta
    const r2 = await s.call('POST', '/provision', { body: { ...BODY, accountId: 99 } });
    assert.equal(r2.status, 403);
  } finally { await s.close(); }
});

test('sesión inválida o headers ausentes', async () => {
  const s = await setup();
  try {
    const noHeaders = await s.call('POST', '/provision', { body: BODY, devise: null });
    assert.equal(noHeaders.status, 401);
    const bad = await s.call('POST', '/provision', { body: BODY, devise: { ...DEVISE, 'access-token': 'otro' } });
    assert.equal(bad.status, 401);
    assert.equal(s.ac.state.calls.length, 0);
  } finally { await s.close(); }
});

test('validación de entrada → 400', async () => {
  const s = await setup();
  try {
    for (const b of [
      { ...BODY, phone: '123' },
      { ...BODY, phone: 'abc' },
      { ...BODY, inboxName: '<>' },
      { ...BODY, method: 'sms' },
      { ...BODY, method: 'code', phone: '' },
      { ...BODY, accountId: 'x' },
    ]) {
      const r = await s.call('POST', '/provision', { body: b });
      assert.equal(r.status, 400, JSON.stringify(b));
    }
    assert.equal(s.ac.state.calls.length, 0);
  } finally { await s.close(); }
});

// ----- rollback -----

for (const failing of ['setChatwoot', 'setRecording', 'pairCode']) {
  test(`rollback: falla ${failing} → se borran bandeja y sesión`, async () => {
    const s = await setup({ acOpts: { fail: failing } });
    try {
      const r = await s.call('POST', '/provision', { body: { ...BODY, method: failing === 'pairCode' ? 'code' : 'qr' } });
      assert.equal(r.status, 502);
      assert.match(r.json.error, /AstraCalls/);
      assert.match(r.json.error, /revirtieron/);
      assert.equal(s.cw.state.inboxes.size, 0, 'bandeja borrada');
      assert.equal(s.ac.state.sessions.size, 0, 'sesión borrada');
      assert.ok(ops(s.ac).includes('deleteSession'));
      assert.ok(s.cw.state.calls.some((c) => c.method === 'DELETE'));
    } finally { await s.close(); }
  });
}

test('rollback: falla la creación de la bandeja → se borra la sesión', async () => {
  const s = await setup();
  s.cw.state.failCreate = true;
  try {
    const r = await s.call('POST', '/provision', { body: BODY });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /bandeja/);
    assert.equal(s.ac.state.sessions.size, 0);
    assert.ok(!s.cw.state.calls.some((c) => c.method === 'DELETE'), 'no había bandeja que borrar');
  } finally { await s.close(); }
});

test('falla la creación de sesión: nada que revertir', async () => {
  const s = await setup({ acOpts: { fail: 'createSession' } });
  try {
    const r = await s.call('POST', '/provision', { body: BODY });
    assert.equal(r.status, 502);
    assert.equal(s.cw.state.inboxes.size, 0);
    assert.equal(s.cw.state.calls.filter((c) => c.path.includes('/inboxes') && c.method !== 'GET').length, 0);
  } finally { await s.close(); }
});

test('cancelar revierte lo creado; no se puede cancelar una conectada', async () => {
  const s = await setup();
  try {
    const r = await s.call('POST', '/provision', { body: BODY });
    const id = r.json.provisionId;
    const c = await s.call('DELETE', `/provision/${id}`);
    assert.equal(c.json.state, 'cancelled');
    assert.equal(s.cw.state.inboxes.size, 0);
    assert.equal(s.ac.state.sessions.size, 0);
    const st = await s.call('GET', `/provision/${id}/status`);
    assert.equal(st.json.state, 'cancelled');

    const r2 = await s.call('POST', '/provision', { body: BODY });
    s.astracalls._onEvent({ type: 'session-list', sessions: [{ id: 'sess2', state: 'open', paired: true, jid: '1:2@s.whatsapp.net' }] });
    await s.call('GET', `/provision/${r2.json.provisionId}/status`);
    const c2 = await s.call('DELETE', `/provision/${r2.json.provisionId}`);
    assert.equal(c2.json.state, 'connected');
    assert.equal(s.cw.state.inboxes.size, 1);
  } finally { await s.close(); }
});

test('expiración: la solicitud sin conectar se revierte y se olvida', async () => {
  const s = await setup();
  try {
    const r = await s.call('POST', '/provision', { body: BODY });
    s.provisioner.now = () => Date.now() + 16 * 60 * 1000 + 61000;
    await s.provisioner.sweep();
    assert.equal(s.provisioner.items.size, 0);
    assert.equal(s.cw.state.inboxes.size, 0);
    assert.equal(s.ac.state.sessions.size, 0);
    const st = await s.call('GET', `/provision/${r.json.provisionId}/status`);
    assert.equal(st.status, 404);
  } finally { await s.close(); }
});

test('otro usuario no puede consultar la solicitud ajena', async () => {
  const s = await setup({ cwOpts: { users: {
    'admin@example.com': { id: 1, role: 'administrator', accountId: 7, token: USER_TOKEN },
    'otro@example.com': { id: 3, role: 'administrator', accountId: 7, token: USER_TOKEN },
  } } });
  try {
    const r = await s.call('POST', '/provision', { body: BODY });
    const st = await s.call('GET', `/provision/${r.json.provisionId}/status`, { devise: { ...DEVISE, uid: 'otro@example.com' } });
    assert.equal(st.status, 404);
  } finally { await s.close(); }
});

test('QR caducado (logged_out): se pide uno nuevo con /pair (limitado)', async () => {
  const s = await setup();
  try {
    const r = await s.call('POST', '/provision', { body: BODY });
    const base = Date.now();
    s.provisioner.now = () => base + 30000;
    s.astracalls._onEvent({ type: 'auth-state', sessionId: 'sess1', state: 'logged_out', paired: false, qr: '' });
    await s.call('GET', `/provision/${r.json.provisionId}/status`);
    await s.call('GET', `/provision/${r.json.provisionId}/status`);
    assert.equal(ops(s.ac).filter((o) => o === 'pair').length, 1);
  } finally { await s.close(); }
});

// ----- cupos -----

test('cuenta fuera de ALLOWED_ACCOUNT_IDS → 403 sin crear nada', async () => {
  const s = await setup({ env: { ALLOWED_ACCOUNT_IDS: '1, 2' } });
  try {
    const r = await s.call('POST', '/provision', { body: BODY }); // cuenta 7
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'Esta cuenta no tiene habilitado WhatsApp + Llamadas. Contacta a soporte.');
    assert.equal(s.ac.state.calls.length, 0);
    assert.equal(s.cw.state.inboxes.size, 0);
  } finally { await s.close(); }
});

test('cuenta dentro de ALLOWED_ACCOUNT_IDS → permitida', async () => {
  const s = await setup({ env: { ALLOWED_ACCOUNT_IDS: '1,7' } });
  try {
    assert.equal((await s.call('POST', '/provision', { body: BODY })).status, 201);
  } finally { await s.close(); }
});

test('límite MAX_SESSIONS_PER_ACCOUNT (def. 1) → 409 sin crear nada', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('POST', '/provision', { body: BODY })).status, 201);
    const before = s.ac.state.calls.length;
    const r = await s.call('POST', '/provision', { body: { ...BODY, inboxName: 'Otra' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'Alcanzaste el límite de números de tu plan.');
    assert.equal(s.ac.state.calls.length, before);
    assert.equal(s.cw.state.inboxes.size, 1);
  } finally { await s.close(); }
});

test('el cupo solo cuenta bandejas con webhook de AstraCalls y respeta el máximo configurado', async () => {
  const s = await setup({ env: { MAX_SESSIONS_PER_ACCOUNT: '2' } });
  s.cw.state.extraInboxes = [{ id: 1, channel_type: 'Channel::Api', webhook_url: 'https://otro.example.com/hook' }, { id: 2, channel_type: 'Channel::Web' }];
  try {
    assert.equal((await s.call('POST', '/provision', { body: BODY })).status, 201);
    assert.equal((await s.call('POST', '/provision', { body: { ...BODY, inboxName: 'B' } })).status, 201);
    assert.equal((await s.call('POST', '/provision', { body: { ...BODY, inboxName: 'C' } })).status, 409);
  } finally { await s.close(); }
});

// ----- seguridad -----

test('CORS estricto', async () => {
  const s = await setup();
  try {
    const bad = await s.call('POST', '/provision', { body: BODY, origin: 'https://evil.example.com' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    assert.equal(s.ac.state.calls.length, 0);
    const ok = await s.call('GET', '/provision/zzz/status', { origin: 'https://crm.example.com' });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://crm.example.com');
    const pre = await s.call('OPTIONS', '/provision', { origin: 'https://crm.example.com' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /access-token/);
  } finally { await s.close(); }
});

test('rate limit por IP', async () => {
  const s = await setup({ env: { RATE_IP_PER_MIN: '3', RATE_ACCOUNT_PER_MIN: '100' } });
  try {
    const out = [];
    for (let i = 0; i < 5; i++) out.push((await s.call('POST', '/provision', { body: { ...BODY, phone: '1' } })).status);
    assert.deepEqual(out, [400, 400, 400, 429, 429]);
  } finally { await s.close(); }
});

test('rate limit por cuenta', async () => {
  const s = await setup({ env: { RATE_IP_PER_MIN: '100', RATE_ACCOUNT_PER_MIN: '2' } });
  try {
    const out = [];
    for (let i = 0; i < 4; i++) out.push((await s.call('POST', '/provision', { body: { ...BODY, phone: '1' } })).status);
    assert.deepEqual(out, [400, 400, 429, 429]);
  } finally { await s.close(); }
});

test('los logs nunca contienen tokens ni la API key', async () => {
  const s = await setup({ acOpts: { fail: 'setChatwoot' } });
  try {
    await s.call('POST', '/provision', { body: BODY });
    s.ac.state.fail = null;
    await s.call('POST', '/provision', { body: BODY });
    const dump = JSON.stringify(s.logs);
    for (const secret of [USER_TOKEN, SECRET_API_KEY, DEVISE['access-token'], DEVISE.client]) assert.ok(!dump.includes(secret), secret);
    assert.ok(s.logs.length > 0);
  } finally { await s.close(); }
});

test('AstraCalls recibe siempre la API key maestra', async () => {
  const s = await setup();
  try {
    await s.call('POST', '/provision', { body: BODY });
    assert.equal(s.ac.state.authKeyOk, true);
  } finally { await s.close(); }
});

test('SSE: el cliente cachea QR y estado desde /api/events', async () => {
  const s = await setup();
  try {
    s.astracalls.startWatching();
    for (let i = 0; i < 50 && !s.ac.state.sse; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(s.ac.state.sse, 'SSE conectado');
    const send = (o) => s.ac.state.sse.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ type: 'session-qr', sessionId: 'abc', qr: 'QRDATA' });
    for (let i = 0; i < 50 && !s.astracalls.auth.get('abc'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.astracalls.auth.get('abc').qr, 'QRDATA');
  } finally { await s.close(); }
});

// ---------- conectar una bandeja existente ----------

function seedInboxes(s) {
  s.cw.state.inboxes.set(50, { name: 'WhatsApp Ventas', channel: { type: 'api', webhook_url: 'https://evo.example.com/chatwoot/webhook/x' } });
  s.cw.state.inboxes.set(51, { name: 'Correo', channelType: 'Channel::Email', channel: {} });
  s.cw.state.inboxes.set(52, { name: 'Ya conectada', channel: { type: 'api', webhook_url: 'https://calls.example.com/api/sessions/sessX/chatwoot/webhook' } });
}

test('bandejas disponibles: solo las de tipo API no conectadas a AstraCalls', async () => {
  const s = await setup({ env: { MAX_SESSIONS_PER_ACCOUNT: '5' } });
  try {
    seedInboxes(s);
    const r = await s.call('GET', '/inbox/available?accountId=7');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.inboxes, [{ id: 50, name: 'WhatsApp Ventas', otherProvider: false }]);
    const other = await s.call('GET', '/inbox/available?accountId=8');
    assert.equal(other.status, 403);
  } finally { await s.close(); }
});

test('bandeja existente: cambia el webhook, no crea bandeja y no importa historial', async () => {
  const s = await setup({ env: { MAX_SESSIONS_PER_ACCOUNT: '5' } });
  try {
    seedInboxes(s);
    const r = await s.call('POST', '/provision', { body: { ...BODY, inboxName: '', existingInboxId: 50, importHistory: true } });
    assert.equal(r.status, 201);
    assert.equal(s.cw.state.calls.filter((c) => c.method === 'POST' && /\/inboxes$/.test(c.path)).length, 0, 'no crea bandeja');
    assert.equal(s.cw.state.inboxes.get(50).channel.webhook_url, 'https://calls.example.com/api/sessions/sess1/chatwoot/webhook');
    assert.equal(s.ac.state.calls[0].body.name, 'WhatsApp Ventas');
    const cfg = s.ac.state.calls.find((c) => c.op === 'setChatwoot').body;
    assert.equal(cfg.inbox_id, 50);
    assert.equal(cfg.inbox_identifier, 'ident-50');
    assert.equal(cfg.import_history, false);

    // cancelar: devuelve el webhook anterior y NO borra la bandeja
    const c = await s.call('DELETE', `/provision/${r.json.provisionId}`);
    assert.equal(c.json.state, 'cancelled');
    assert.ok(s.cw.state.inboxes.has(50), 'la bandeja existente no se borra');
    assert.equal(s.cw.state.inboxes.get(50).channel.webhook_url, 'https://evo.example.com/chatwoot/webhook/x');
    assert.ok(!s.ac.state.sessions.has('sess1'));
  } finally { await s.close(); }
});

test('bandeja existente: falla un paso → se restaura el webhook, la bandeja queda', async () => {
  const s = await setup({ env: { MAX_SESSIONS_PER_ACCOUNT: '5' }, acOpts: { fail: 'setChatwoot' } });
  try {
    seedInboxes(s);
    const r = await s.call('POST', '/provision', { body: { ...BODY, existingInboxId: 50 } });
    assert.ok(r.status >= 500);
    assert.match(r.json.error, /Se revirtieron/);
    assert.ok(s.cw.state.inboxes.has(50));
    assert.equal(s.cw.state.inboxes.get(50).channel.webhook_url, 'https://evo.example.com/chatwoot/webhook/x');
  } finally { await s.close(); }
});

test('bandeja existente: rechaza la que no es API, la ya conectada o una inexistente', async () => {
  const s = await setup({ env: { MAX_SESSIONS_PER_ACCOUNT: '5' } });
  try {
    seedInboxes(s);
    const notApi = await s.call('POST', '/provision', { body: { ...BODY, existingInboxId: 51 } });
    assert.equal(notApi.status, 400);
    const managed = await s.call('POST', '/provision', { body: { ...BODY, existingInboxId: 52 } });
    assert.equal(managed.status, 409);
    const missing = await s.call('POST', '/provision', { body: { ...BODY, existingInboxId: 999 } });
    assert.equal(missing.status, 404);
    const bad = await s.call('POST', '/provision', { body: { ...BODY, existingInboxId: 'abc' } });
    assert.equal(bad.status, 400);
    assert.equal(s.ac.state.calls.filter((c) => c.op === 'createSession').length, 0);
  } finally { await s.close(); }
});

test('/healthz muestra la versión que corre', async () => {
  const s = await setup();
  try {
    const r = await s.call('GET', '/healthz', { origin: null, devise: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.match(r.json.version, /^prov-v\d+\.\d+\.\d+/);
  } finally { await s.close(); }
});

// ---------- bandeja que venía de Evolution ----------

function seedEvolution(s, instance = '5215550001234') {
  s.cw.state.inboxes.set(60, { name: 'WhatsApp Evo', channel: { type: 'api', webhook_url: s.evo.url + '/chatwoot/webhook/' + instance } });
}

test('Evolution: se marca la bandeja y la instancia se apaga solo al conectar', async () => {
  const s = await setup({ env: { MAX_SESSIONS_PER_ACCOUNT: '5' } });
  try {
    seedEvolution(s);
    seedInboxes(s);
    const av = await s.call('GET', '/inbox/available?accountId=7');
    assert.deepEqual(av.json.inboxes.find((i) => i.id === 60), { id: 60, name: 'WhatsApp Evo', otherProvider: true });
    assert.equal(av.json.inboxes.find((i) => i.id === 50).otherProvider, false, 'otro webhook que no es este Evolution');

    const r = await s.call('POST', '/provision', { body: { ...BODY, existingInboxId: 60 } });
    assert.equal(r.status, 201);
    let st = await s.call('GET', `/provision/${r.json.provisionId}/status`);
    assert.equal(s.evo.state.calls.length, 0, 'no se apaga antes de conectar');

    s.astracalls._onEvent({ type: 'auth-state', sessionId: 'sess1', state: 'open', paired: true, qr: '' });
    st = await s.call('GET', `/provision/${r.json.provisionId}/status`);
    assert.equal(st.json.state, 'connected');
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(s.evo.state.calls.map((c) => [c.method, c.path, c.apikey]), [['DELETE', '/instance/logout/5215550001234', 'EVO-KEY']]);
    await s.call('GET', `/provision/${r.json.provisionId}/status`);
    assert.equal(s.evo.state.calls.length, 1, 'una sola vez');
    assert.ok(!JSON.stringify(s.logs).includes('EVO-KEY'));
  } finally { await s.close(); }
});

test('Evolution: si se cancela, la instancia no se toca', async () => {
  const s = await setup({ env: { MAX_SESSIONS_PER_ACCOUNT: '5' } });
  try {
    seedEvolution(s);
    const r = await s.call('POST', '/provision', { body: { ...BODY, existingInboxId: 60 } });
    await s.call('DELETE', `/provision/${r.json.provisionId}`);
    assert.equal(s.evo.state.calls.length, 0);
    assert.equal(s.cw.state.inboxes.get(60).channel.webhook_url, s.evo.url + '/chatwoot/webhook/5215550001234');
  } finally { await s.close(); }
});

test('Evolution: sin EVOLUTION_URL no se marca ni se apaga nada', async () => {
  const s = await setup({ env: { MAX_SESSIONS_PER_ACCOUNT: '5', EVOLUTION_URL: '' } });
  try {
    seedEvolution(s);
    const av = await s.call('GET', '/inbox/available?accountId=7');
    assert.equal(av.json.inboxes.find((i) => i.id === 60).otherProvider, false);
  } finally { await s.close(); }
});

test('Evolution: instancia leída del webhook', () => {
  const { EvolutionClient } = require('../src/evolution');
  const e = new EvolutionClient({ baseUrl: 'https://evo.example.com', apiKey: 'k' });
  assert.equal(e.instanceFromWebhook('https://evo.example.com/chatwoot/webhook/Ventas%20MX'), 'Ventas MX');
  assert.equal(e.instanceFromWebhook('https://otro.example.com/chatwoot/webhook/x'), null);
  assert.equal(e.instanceFromWebhook('https://evo.example.com/webhook/x'), null);
  assert.equal(e.instanceFromWebhook('https://evo.example.com/chatwoot/webhook/a/b'), null);
  assert.equal(new EvolutionClient({ baseUrl: '', apiKey: '' }).instanceFromWebhook('https://evo.example.com/chatwoot/webhook/x'), null);
});
