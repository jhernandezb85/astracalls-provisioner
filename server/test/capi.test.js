'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CapiStore, CapiSender, cleanCapiFields, parseAmount } = require('../src/capi');

const silent = { info() {}, warn() {}, error() {} };

function tmpStore(secret = 's3cr3t') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capi-'));
  return new CapiStore({ file: path.join(dir, 'capi.json'), secret });
}

const FIELDS = { datasetId: '1449035617173447', wabaId: '2061295954353574', currency: 'PEN', saleLabel: 'venta', metaToken: 'EAAB' + 'x'.repeat(40), testEventCode: '' };

test('store: token cifrado en disco, vista sin secretos, token vacío conserva el anterior', () => {
  const st = tmpStore();
  st.set(1, { ...FIELDS, cwToken: 'cw-token' });
  const raw = fs.readFileSync(st.file, 'utf8');
  assert.ok(!raw.includes(FIELDS.metaToken) && !raw.includes('cw-token'), 'tokens no deben quedar en texto plano');
  assert.equal(st.get(1).metaToken, FIELDS.metaToken);
  const v = st.view(1);
  assert.equal(v.metaToken, undefined);
  assert.equal(v.hookSecret, undefined);
  assert.equal(v.tokenHint, '…' + FIELDS.metaToken.slice(-4));
  const secret = st.get(1).hookSecret;
  st.set(1, { ...FIELDS, metaToken: '', currency: 'USD' });
  assert.equal(st.get(1).metaToken, FIELDS.metaToken);
  assert.equal(st.get(1).hookSecret, secret, 'el secreto del webhook no cambia al guardar');
  // otra llave no descifra
  const other = new CapiStore({ file: st.file, secret: 'otra' });
  assert.equal(other.get(1).metaToken, '');
});

test('cleanCapiFields valida', () => {
  assert.ok(cleanCapiFields({ ...FIELDS, datasetId: 'abc' }, { hasToken: false }).error);
  assert.ok(cleanCapiFields({ ...FIELDS, metaToken: '' }, { hasToken: false }).error);
  assert.ok(!cleanCapiFields({ ...FIELDS, metaToken: '' }, { hasToken: true }).error);
  assert.equal(cleanCapiFields({ ...FIELDS, currency: 'pen', saleLabel: 'Venta' }, { hasToken: false }).fields.currency, 'PEN');
});

test('parseAmount', () => {
  assert.equal(parseAmount(2500), 2500);
  assert.equal(parseAmount('2,500.50'), 2500.5);
  assert.equal(parseAmount('S/ 2500'), 2500);
  assert.equal(parseAmount('12,5'), 12.5);
  assert.equal(parseAmount(''), 0);
  assert.equal(parseAmount(-3), 0);
});

function setup({ metaOk = true } = {}) {
  const st = tmpStore();
  const rec = st.set(1, { ...FIELDS, cwToken: 'cw-token' });
  const sent = [];
  const notes = [];
  const marks = [];
  const fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    return { ok: metaOk, json: async () => (metaOk ? { events_received: 1 } : { error: { message: 'Invalid token' } }) };
  };
  const cw = {
    postPrivateNote: async (...a) => { notes.push(a); return true; },
    mergeConversationAttributes: async (...a) => { marks.push(a); return true; },
  };
  const sender = new CapiSender({ store: st, cw, log: silent, fetch, now: () => Date.UTC(2026, 10, 24, 18, 0, 0) });
  return { sender, rec, sent, notes, marks };
}

const hook = (over = {}) => ({
  event: 'conversation_updated', id: 39077, account: { id: 1 }, labels: ['venta', '912242314'],
  custom_attributes: { ctwa_clid: 'Afj64HAH', meta_ad_id: '120236943712430669', monto: '2500' }, ...over,
});

test('envía Purchase una vez y marca capi_enviado', async () => {
  const { sender, rec, sent, marks } = setup();
  assert.equal(await sender.handle(1, rec.hookSecret, hook()), 'sent');
  assert.equal(sent.length, 1);
  const ev = sent[0].body.data[0];
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.event_id, 'cw-1-39077-purchase');
  assert.equal(ev.action_source, 'business_messaging');
  assert.equal(ev.messaging_channel, 'whatsapp');
  assert.deepEqual(ev.user_data, { whatsapp_business_account_id: FIELDS.wabaId, ctwa_clid: 'Afj64HAH' });
  assert.deepEqual(ev.custom_data, { currency: 'PEN', value: 2500 });
  assert.ok(sent[0].url.endsWith(`/${FIELDS.datasetId}/events`));
  assert.ok(!sent[0].url.includes('access_token'), 'el token no va en la URL');
  assert.equal(marks[0][4].capi_enviado, '24/11/2026 · 2500 PEN');
  // webhook repetido con atributos viejos (antes de la marca): no reenvía
  assert.equal(await sender.handle(1, rec.hookSecret, hook()), 'skip:already_sent');
  assert.equal(sent.length, 1);
});

test('no envía sin etiqueta, sin monto, sin clid, ya enviado o con secreto malo', async () => {
  const { sender, rec, sent } = setup();
  assert.equal(await sender.handle(1, 'malo', hook()), 'skip:bad_secret');
  assert.equal(await sender.handle(1, rec.hookSecret, hook({ labels: ['otra'] })), 'skip:no_label');
  assert.equal(await sender.handle(1, rec.hookSecret, hook({ custom_attributes: { ctwa_clid: 'x' } })), 'skip:no_amount');
  assert.equal(await sender.handle(1, rec.hookSecret, hook({ custom_attributes: { monto: 10 } })), 'skip:no_clid');
  assert.equal(await sender.handle(1, rec.hookSecret, hook({ custom_attributes: { ctwa_clid: 'x', monto: 10, capi_enviado: 'ya' } })), 'skip:already_sent');
  assert.equal(await sender.handle(1, rec.hookSecret, hook({ event: 'message_created' })), 'skip:event');
  assert.equal(await sender.handle(2, rec.hookSecret, hook()), 'skip:no_config');
  assert.equal(sent.length, 0);
});

test('código de prueba va en el envío y en la marca', async () => {
  const { sender, sent, marks } = setup();
  sender.store.set(1, { ...FIELDS, metaToken: '', testEventCode: 'TEST45836' });
  const secret = sender.store.get(1).hookSecret;
  assert.equal(await sender.handle(1, secret, hook()), 'sent');
  assert.equal(sent[0].body.test_event_code, 'TEST45836');
  assert.match(marks[0][4].capi_enviado, /prueba$/);
});

test('si Meta rechaza: nota privada y sin marca', async () => {
  const { sender, rec, notes, marks } = setup({ metaOk: false });
  assert.equal(await sender.handle(1, rec.hookSecret, hook()), 'error:meta');
  assert.equal(marks.length, 0);
  assert.match(notes[0][3], /Invalid token/);
});
