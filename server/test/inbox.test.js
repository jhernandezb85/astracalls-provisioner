'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, DEVISE, USER_TOKEN } = require('./helpers');

const BODY = { accountId: 7, inboxName: 'Ventas', phone: '5215512345678', record: false, method: 'qr' };
const q = (inboxId, accountId = 7) => `?accountId=${accountId}&inboxId=${inboxId}`;

async function provisioned(s, extra = {}) {
  const r = await s.call('POST', '/provision', { body: { ...BODY, ...extra } });
  assert.equal(r.status, 201);
  return { sid: 'sess1', inboxId: 100 };
}

test('aprovisionar con historial y espejo de API los pasa a AstraCalls', async () => {
  const s = await setup();
  try {
    await provisioned(s, { importHistory: true, importHistoryDays: 90, mirrorApi: true });
    const cfg = s.ac.state.calls.find((c) => c.op === 'setChatwoot').body;
    assert.equal(cfg.import_history, true);
    assert.equal(cfg.import_history_days, 90);
    assert.equal(cfg.mirror_api, true);
    // fork de AstraCalls: celular como mensaje que abre la conversación, publicado por
    // el bot de la cuenta, con título en español; checks encendidos
    assert.equal(cfg.device_mode, 'open');
    assert.equal(cfg.device_title, '📱 Enviado desde el celular');
    assert.equal(cfg.device_bot_token, 'BOT-TOKEN-1');
    assert.equal(cfg.read_receipts, true);
    assert.deepEqual(s.cw.state.bots.map((b) => b.name), ['WhatsApp (celular)']);
  } finally { await s.close(); }
});

test('el bot del celular se reutiliza: una sola vez por cuenta', async () => {
  const s = await setup({ env: { MAX_SESSIONS_PER_ACCOUNT: '5' } });
  try {
    await provisioned(s);
    const r = await s.call('POST', '/provision', { body: { ...BODY, inboxName: 'Soporte', deviceMode: 'note' } });
    assert.equal(r.status, 201);
    assert.equal(s.cw.state.bots.length, 1);
    const cfgs = s.ac.state.calls.filter((c) => c.op === 'setChatwoot').map((c) => c.body);
    assert.equal(cfgs[1].device_bot_token, 'BOT-TOKEN-1');
    assert.equal(cfgs[1].device_mode, 'note');
  } finally { await s.close(); }
});

test('si Chatwoot no deja crear el bot, la conexión sigue igual (sin bot)', async () => {
  const s = await setup();
  try {
    s.cw.state.failBots = true;
    await provisioned(s, { deviceMode: 'inventado' });
    const cfg = s.ac.state.calls.find((c) => c.op === 'setChatwoot').body;
    assert.equal(cfg.device_bot_token, undefined);
    assert.equal(cfg.device_mode, 'open', 'opción desconocida → recomendada');
    s.ac.state.sessions.get('sess1').paired = true;
    const r = await s.call('GET', '/inbox/settings' + q(100));
    assert.equal(r.json.deviceBot, false);
    // cuando Chatwoot vuelve a permitirlo, abrir la configuración lo prepara
    s.cw.state.failBots = false;
    const r2 = await s.call('GET', '/inbox/settings' + q(100));
    assert.equal(r2.json.deviceBot, true);
    assert.equal(s.ac.state.sessions.get('sess1').chatwoot.device_bot_token, 'BOT-TOKEN-1');
  } finally { await s.close(); }
});

test('bandeja conectada antes del bot: al abrir la configuración recibe bot y título', async () => {
  const s = await setup();
  try {
    await provisioned(s);
    const sess = s.ac.state.sessions.get('sess1');
    delete sess.chatwoot.device_bot_token; delete sess.chatwoot.device_title; delete sess.chatwoot.device_mode; delete sess.chatwoot.read_receipts;
    const r = await s.call('GET', '/inbox/settings' + q(100));
    assert.equal(r.status, 200);
    assert.equal(r.json.deviceMode, 'open', 'sin el campo = recomendado');
    assert.equal(r.json.readReceipts, true, 'sin el campo = encendido');
    assert.equal(r.json.deviceBot, true);
    assert.equal(sess.chatwoot.device_title, '📱 Enviado desde el celular');
    const n = s.ac.state.calls.filter((c) => c.op === 'setChatwoot').length;
    await s.call('GET', '/inbox/settings' + q(100));
    assert.equal(s.ac.state.calls.filter((c) => c.op === 'setChatwoot').length, n, 'ya preparado: no vuelve a escribir');
  } finally { await s.close(); }
});

test('por defecto: sin historial, sin espejo, días = 30; días no permitidos → 30', async () => {
  const s = await setup();
  try {
    await provisioned(s, { importHistoryDays: 365 });
    const cfg = s.ac.state.calls.find((c) => c.op === 'setChatwoot').body;
    assert.equal(cfg.import_history, false);
    assert.equal(cfg.mirror_api, false);
    assert.equal(cfg.import_history_days, 30);
  } finally { await s.close(); }
});

test('leer y cambiar la configuración de una bandeja conectada', async () => {
  const s = await setup();
  try {
    await provisioned(s);
    s.astracalls._onEvent({ type: 'session-list', sessions: [] }); // sin efecto en el GET
    s.ac.state.sessions.get('sess1').paired = true;
    s.ac.state.sessions.get('sess1').state = 'open';
    s.ac.state.sessions.get('sess1').jid = '5215512345678:3@s.whatsapp.net';

    let r = await s.call('GET', '/inbox/settings' + q(100));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      managed: true, connected: true, phone: '5215512345678', recording: false,
      mirrorApi: false, deviceMode: 'open', deviceBot: true, readReceipts: true,
      importHistory: false, importHistoryDays: 30, mcpEndpoint: 'https://calls.example.com/mcp',
    });

    r = await s.call('PUT', '/inbox/settings', { body: { accountId: 7, inboxId: 100, recording: true, mirrorApi: true, deviceMode: 'keep', readReceipts: false, importHistory: true, importHistoryDays: 7 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.recording, true);
    assert.equal(r.json.mirrorApi, true);
    assert.equal(r.json.deviceMode, 'keep');
    assert.equal((await s.call('PUT', '/inbox/settings', { body: { accountId: 7, inboxId: 100, deviceMode: 'otro' } })).status, 400);
    assert.equal(r.json.readReceipts, false);
    assert.equal(r.json.importHistory, true);
    assert.equal(r.json.importHistoryDays, 7);

    // el cambio parcial no borra la config ni el token guardado en AstraCalls
    const stored = s.ac.state.sessions.get('sess1').chatwoot;
    assert.equal(stored.account_token, USER_TOKEN);
    assert.equal(stored.inbox_id, 100);
    assert.equal(stored.url, s.cfg.chatwootUrl);
  } finally { await s.close(); }
});

test('bandeja que no es de AstraCalls → 404 claro', async () => {
  const s = await setup();
  try {
    await provisioned(s);
    s.cw.state.inboxes.set(555, { name: 'Web', channel: { type: 'api', webhook_url: 'https://otro.example.com/hook' } });
    const r = await s.call('GET', '/inbox/settings' + q(555));
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no está conectada/);
    assert.equal((await s.call('GET', '/inbox/settings' + q(999))).status, 404); // inexistente
  } finally { await s.close(); }
});

test('seguridad: una bandeja que apunta a la sesión de OTRA cuenta/bandeja no da acceso', async () => {
  const s = await setup();
  try {
    await provisioned(s); // sess1 ↔ cuenta 7, bandeja 100
    // otro admin crea su propia bandeja API y pone el webhook de sess1 a mano
    s.cw.state.inboxes.set(777, { name: 'Ataque', channel: { type: 'api', webhook_url: 'https://calls.example.com/api/sessions/sess1/chatwoot/webhook' } });
    for (const [method, path, body] of [
      ['GET', '/inbox/settings' + q(777)],
      ['PUT', '/inbox/settings', { accountId: 7, inboxId: 777, recording: true }],
      ['GET', '/inbox/mcp-keys' + q(777)],
      ['POST', '/inbox/mcp-keys', { accountId: 7, inboxId: 777, name: 'x' }],
    ]) {
      const r = await s.call(method, path, { body });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
    assert.equal(s.ac.state.sessions.get('sess1').recording, undefined, 'no se tocó la grabación');
    assert.equal((s.ac.state.sessions.get('sess1').mcp || []).length, 0, 'no se creó ninguna llave');
    // y el webhook con ruta extraña tampoco
    s.cw.state.inboxes.set(778, { name: 'X', channel: { type: 'api', webhook_url: 'https://calls.example.com/api/sessions/sess1/../x/chatwoot/webhook' } });
    assert.equal((await s.call('GET', '/inbox/settings' + q(778))).status, 404);
  } finally { await s.close(); }
});

test('seguridad: solo administradores de la cuenta', async () => {
  const s = await setup({ cwOpts: { users: {
    'admin@example.com': { id: 1, role: 'administrator', accountId: 7, token: USER_TOKEN },
    'agente@example.com': { id: 2, role: 'agent', accountId: 7, token: USER_TOKEN },
  } } });
  try {
    await provisioned(s);
    const agent = { ...DEVISE, uid: 'agente@example.com' };
    assert.equal((await s.call('GET', '/inbox/settings' + q(100), { devise: agent })).status, 403);
    assert.equal((await s.call('POST', '/inbox/mcp-keys', { body: { accountId: 7, inboxId: 100, name: 'x' }, devise: agent })).status, 403);
    assert.equal((await s.call('GET', '/inbox/settings' + q(100), { devise: null })).status, 401);
    assert.equal((await s.call('GET', '/inbox/settings' + q(100, 8))).status, 403, 'otra cuenta');
  } finally { await s.close(); }
});

test('llaves MCP: una sola por bandeja y sin revocar desde Chatwoot', async () => {
  const s = await setup();
  try {
    await provisioned(s);
    const c = await s.call('POST', '/inbox/mcp-keys', { body: { accountId: 7, inboxId: 100, name: 'Bot' } });
    assert.equal(c.status, 201);
    const again = await s.call('POST', '/inbox/mcp-keys', { body: { accountId: 7, inboxId: 100, name: 'Otro' } });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /ya tiene su llave/);
    assert.equal(s.ac.state.sessions.get('sess1').mcp.length, 1);
    const l = await s.call('GET', '/inbox/mcp-keys' + q(100));
    assert.equal(l.json.max, 1);
    // no existe ruta para revocar
    assert.equal((await s.call('DELETE', `/inbox/mcp-keys/${c.json.key.id}` + q(100))).status, 404);
    assert.equal(s.ac.state.sessions.get('sess1').mcp.length, 1, 'la llave sigue');
    assert.ok(!s.ac.state.calls.some((x) => x.op === 'deleteMcp'));
  } finally { await s.close(); }
});

test('MCP_KEYS_PER_INBOX permite más de una llave', async () => {
  const s = await setup({ env: { MCP_KEYS_PER_INBOX: '2' } });
  try {
    await provisioned(s);
    assert.equal((await s.call('POST', '/inbox/mcp-keys', { body: { accountId: 7, inboxId: 100, name: 'a' } })).status, 201);
    assert.equal((await s.call('POST', '/inbox/mcp-keys', { body: { accountId: 7, inboxId: 100, name: 'b' } })).status, 201);
    assert.equal((await s.call('POST', '/inbox/mcp-keys', { body: { accountId: 7, inboxId: 100, name: 'c' } })).status, 409);
  } finally { await s.close(); }
});

test('la página del aviso de uso responsable se sirve como HTML con CSP', async () => {
  const s = await setup();
  try {
    const r = await s.call('GET', '/aviso-ia', { devise: null, origin: null });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    const js = await s.call('GET', '/connector.js', { devise: null, origin: null });
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal(js.headers.get('cache-control'), 'no-cache');
  } finally { await s.close(); }
});

test('llaves MCP: crear (secreto una sola vez) y listar sin secreto', async () => {
  const s = await setup();
  try {
    await provisioned(s);
    const c = await s.call('POST', '/inbox/mcp-keys', { body: { accountId: 7, inboxId: 100, name: ' <b>Mi bot</b> ', readOnly: true } });
    assert.equal(c.status, 201);
    assert.match(c.json.secret, /^acmcp_/);
    assert.equal(c.json.url, 'https://calls.example.com/mcp/' + c.json.secret);
    assert.equal(c.json.endpoint, 'https://calls.example.com/mcp');
    assert.equal(c.json.key.name, 'bMi bot/b');
    assert.equal(c.json.key.readOnly, true);
    assert.equal(c.headers.get('cache-control'), 'no-store');

    const l = await s.call('GET', '/inbox/mcp-keys' + q(100));
    assert.equal(l.status, 200);
    assert.equal(l.json.keys.length, 1);
    assert.ok(!JSON.stringify(l.json).includes(c.json.secret), 'la lista nunca trae el secreto');

    // el secreto nunca aparece en los logs
    assert.ok(!JSON.stringify(s.logs).includes(c.json.secret));
  } finally { await s.close(); }
});

test('CORS permite PUT desde Chatwoot', async () => {
  const s = await setup();
  try {
    const pre = await s.call('OPTIONS', '/inbox/settings');
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
  } finally { await s.close(); }
});
