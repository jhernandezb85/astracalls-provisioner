'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, DEVISE } = require('./helpers');

const AGENT = { [DEVISE.uid]: { id: 2, role: 'agent', accountId: 7, token: 'AGENT-TOKEN' } };
const ops = (ac) => ac.state.calls.map((c) => c.op);

// sesión de AstraCalls conectada a la bandeja 100 de la cuenta 7, y conversación 55 en esa bandeja
async function prepared(convOpts = {}) {
  const s = await setup({ cwOpts: { users: AGENT } });
  s.ac.state.sessions.set('sessA', { name: 'Ventas', chatwoot: { url: s.cfg.chatwootUrl, account_id: 7, inbox_id: 100 } });
  s.cw.state.conversations.set(55, { inbox_id: 100, ...convOpts });
  return s;
}
const BODY = { accountId: 7, conversationId: 55, messageId: 901, text: '  Texto corregido  ' };

test('un agente con acceso a la conversación edita el mensaje en WhatsApp', async () => {
  const s = await prepared({ tokens: ['AGENT-TOKEN'] });
  try {
    const r = await s.call('POST', '/message/edit', { body: BODY });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { edited: true });
    const call = s.ac.state.calls.find((c) => c.op === 'editMessage');
    assert.match(call.path, /^\/api\/sessions\/sessA\/chatwoot\/messages\/901\/edit$/);
    assert.deepEqual(call.body, { text: 'Texto corregido', conversationId: 55 });
  } finally { await s.close(); }
});

test('sin acceso a la conversación no se edita nada', async () => {
  const s = await prepared({ tokens: ['OTRO-TOKEN'] });
  try {
    const r = await s.call('POST', '/message/edit', { body: BODY });
    assert.equal(r.status, 404);
    assert.ok(!ops(s.ac).includes('editMessage'));
  } finally { await s.close(); }
});

test('conversación de una bandeja que no es de WhatsApp + Llamadas → 404', async () => {
  const s = await prepared();
  try {
    s.cw.state.conversations.set(56, { inbox_id: 999 });
    const r = await s.call('POST', '/message/edit', { body: { ...BODY, conversationId: 56 } });
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'not_managed');
    assert.ok(!ops(s.ac).includes('editMessage'));
  } finally { await s.close(); }
});

test('si AstraCalls no deja (pasaron 15 min), se muestra su motivo', async () => {
  const s = await prepared();
  try {
    s.ac.state.editResult = [409, { error: 'too_late', message: 'WhatsApp solo permite editar durante 15 minutos después de enviar.' }];
    const r = await s.call('POST', '/message/edit', { body: BODY });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'too_late');
    assert.match(r.json.error, /15 minutos/);
  } finally { await s.close(); }
});

test('datos no válidos → 400 sin llamar a nadie', async () => {
  const s = await prepared();
  try {
    for (const b of [{ ...BODY, text: '   ' }, { ...BODY, messageId: 'x' }, { ...BODY, text: 'a'.repeat(4097) }]) {
      const r = await s.call('POST', '/message/edit', { body: b });
      assert.equal(r.status, 400);
    }
    assert.ok(!ops(s.ac).includes('editMessage'));
  } finally { await s.close(); }
});
