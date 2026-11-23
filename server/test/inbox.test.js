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
      mirrorApi: false, importHistory: false, importHistoryDays: 30, mcpEndpoint: 'https://calls.example.com/mcp',
    });

    r = await s.call('PUT', '/inbox/settings', { body: { accountId: 7, inboxId: 100, recording: true, mirrorApi: true, importHistory: true, importHistoryDays: 7 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.recording, true);
    assert.equal(r.json.mirrorApi, true);
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

test('llaves MCP: crear (secreto una sola vez), listar sin secreto y revocar', async () => {
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

    const d = await s.call('DELETE', `/inbox/mcp-keys/${c.json.key.id}` + q(100));
    assert.equal(d.status, 200);
    assert.equal((await s.call('GET', '/inbox/mcp-keys' + q(100))).json.keys.length, 0);
    assert.equal((await s.call('DELETE', `/inbox/mcp-keys/${c.json.key.id}` + q(100))).status, 404);
    assert.equal((await s.call('DELETE', '/inbox/mcp-keys/..%2Fx' + q(100))).status, 400);

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
