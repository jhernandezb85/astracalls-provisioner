'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const BODY = { accountId: 7, inboxName: 'Ventas', record: false, method: 'qr' };
const ops = (ac) => ac.state.calls.map((c) => c.op);

// Sesión desvinculada (su bandeja se borró) que AstraCalls guarda 24 h.
function addOrphan(s, { sid = 'old1', accountId = 7, url, purgeIn = 3600000, name = 'Ventas viejo', phone = '5215500000000' } = {}) {
  s.ac.state.sessions.set(sid, { name, chatwoot: { url: url || s.cfg.chatwootUrl, account_id: accountId, inbox_id: 99 } });
  s.ac.state.orphans.push({
    sessionId: sid, name, phone, chatwootUrl: url || s.cfg.chatwootUrl, accountId,
    orphanSince: Date.now() - 1000, purgeAt: Date.now() + purgeIn,
  });
}

test('lista solo los números desvinculados de esta cuenta y este Chatwoot, vigentes', async () => {
  const s = await setup();
  try {
    addOrphan(s, { sid: 'mine' });
    addOrphan(s, { sid: 'otraCuenta', accountId: 8 });
    addOrphan(s, { sid: 'otroCrm', url: 'https://otro-crm.example.com' });
    addOrphan(s, { sid: 'vencido', purgeIn: -1000 });
    const r = await s.call('GET', '/inbox/recoverable?accountId=7');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.numbers.map((n) => n.sessionId), ['mine']);
    assert.equal(r.json.numbers[0].phone, '5215500000000');
  } finally { await s.close(); }
});

test('recuperar: reutiliza la sesión, la conecta a una bandeja nueva y pide QR', async () => {
  const s = await setup();
  try {
    addOrphan(s);
    const r = await s.call('POST', '/provision', { body: { ...BODY, recoverSessionId: 'old1', importHistory: true } });
    assert.equal(r.status, 201);
    assert.ok(!ops(s.ac).includes('createSession'), 'no crea sesión nueva');
    assert.deepEqual(ops(s.ac).filter((o) => o !== 'orphans'), ['setChatwoot', 'pair']);
    const setCw = s.ac.state.calls.find((c) => c.op === 'setChatwoot');
    assert.match(setCw.path, /\/api\/sessions\/old1\/chatwoot$/);
    assert.equal(setCw.body.import_history, true, 'la bandeja borrada perdió sus conversaciones: se puede importar');
    const inbox = [...s.cw.state.inboxes.values()][0];
    assert.equal(inbox.channel.webhook_url, 'https://calls.example.com/api/sessions/old1/chatwoot/webhook');
  } finally { await s.close(); }
});

test('cancelar una recuperación borra la bandeja nueva pero NO la sesión', async () => {
  const s = await setup();
  try {
    addOrphan(s);
    const r = await s.call('POST', '/provision', { body: { ...BODY, recoverSessionId: 'old1' } });
    const c = await s.call('DELETE', `/provision/${r.json.provisionId}`);
    assert.equal(c.json.state, 'cancelled');
    assert.ok(s.cw.state.calls.some((x) => x.method === 'DELETE'), 'borra la bandeja creada');
    assert.ok(!ops(s.ac).includes('deleteSession'), 'la sesión sigue en su plazo de 24 h');
    assert.ok(s.ac.state.sessions.has('old1'));
  } finally { await s.close(); }
});

test('no se puede recuperar un número de otra cuenta, vencido o inventado', async () => {
  const s = await setup();
  try {
    addOrphan(s, { sid: 'ajeno', accountId: 8 });
    addOrphan(s, { sid: 'vencido', purgeIn: -1000 });
    for (const sid of ['ajeno', 'vencido', 'noexiste']) {
      const r = await s.call('POST', '/provision', { body: { ...BODY, recoverSessionId: sid } });
      assert.equal(r.status, 404, sid);
      assert.equal(r.json.code, 'recover_not_found');
    }
    const bad = await s.call('POST', '/provision', { body: { ...BODY, recoverSessionId: '../x' } });
    assert.equal(bad.status, 400);
    assert.ok(!ops(s.ac).includes('setChatwoot'));
  } finally { await s.close(); }
});
