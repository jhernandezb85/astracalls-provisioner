'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const jsQR = require('jsqr');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'connector.js'), 'utf8');

// ---------- QR ----------
function loadQR() {
  const win = { __ASTRA_CONNECTOR_TEST__: true };
  vm.runInNewContext(SRC, { window: win, document: {}, unescape, encodeURIComponent, Math, Array, Error });
  return win.__astraQR;
}

function decode(m) {
  const n = m.length, scale = 6, border = 4, W = (n + 2 * border) * scale;
  const px = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + border) * scale + dy) * W + (x + border) * scale + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  const r = jsQR(px, W, W);
  return r && r.data;
}

test('QR embebido: se puede decodificar (tamaños tipo WhatsApp y otros)', () => {
  const { qrEncode } = loadQR();
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=,@';
  let seed = 42;
  const rnd = (n) => { let s = ''; for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; s += chars[seed % chars.length]; } return s; };
  const texts = ['hola', 'ñandú ✓ 日本語', '2@' + rnd(150) + ',' + rnd(44) + ',' + rnd(44) + ',1', rnd(300), rnd(620), rnd(900)];
  for (const t of texts) assert.equal(decode(qrEncode(t)), t, 'len ' + t.length);
});

// ---------- inyección en el DOM ----------
const CARD = (title, extra = '') => `
  <button class="relative bg-n-solid-1 cursor-pointer rounded-2xl flex flex-col" ${extra}>
    <div class="relative"><div class="flex size-10 rounded-full bg-n-alpha-2"><span class="i-woot-api size-6"></span></div></div>
    <div class="flex flex-col items-start gap-1.5">
      <div class="flex items-center gap-2"><h3 class="capitalize">${title}</h3><span class="label">Beta</span></div>
      <p>desc ${title}</p>
    </div>
  </button>`;
const PAGE = `<div id="app"><div class="grid" id="grid">${['Website', 'Facebook', 'WhatsApp', 'API'].map((t) => CARD(t)).join('')}</div></div>`;

function boot(url, html = PAGE, cookie) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  if (cookie) dom.window.document.cookie = cookie;
  const s = dom.window.document.createElement('script');
  s.setAttribute('data-provisioner', 'https://prov.example.com');
  s.textContent = SRC;
  dom.window.document.body.appendChild(s);
  return dom;
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('inserta la tarjeta con el estilo de las existentes en /settings/inboxes/new', async () => {
  const dom = boot('https://crm.example.com/app/accounts/7/settings/inboxes/new');
  await tick();
  const grid = dom.window.document.getElementById('grid');
  const card = grid.querySelector('[data-astra-card]');
  assert.ok(card, 'tarjeta insertada');
  assert.equal(grid.children.length, 5);
  assert.equal(card.querySelector('h3').textContent, 'WhatsApp + Llamadas');
  assert.match(card.className, /bg-n-solid-1/, 'hereda las clases de las demás');
  assert.ok(!card.querySelector('.label'), 'sin insignia Beta');
  assert.ok(card.querySelector('svg'), 'icono propio');
  // no duplica al mutar el DOM
  grid.appendChild(dom.window.document.createElement('i'));
  await tick();
  assert.equal(grid.querySelectorAll('[data-astra-card]').length, 1);
  dom.window.close();
});

test('SPA: aparece al navegar a la ruta con pushState', async () => {
  const dom = boot('https://crm.example.com/app/accounts/7/settings/inboxes');
  await tick();
  assert.equal(dom.window.document.querySelector('[data-astra-card]'), null);
  dom.window.history.pushState({}, '', '/app/accounts/7/settings/inboxes/new');
  await tick();
  assert.ok(dom.window.document.querySelector('[data-astra-card]'));
  dom.window.close();
});

test('no hace nada en otras rutas ni si no encuentra la rejilla', async () => {
  const other = boot('https://crm.example.com/app/accounts/7/dashboard');
  await tick();
  assert.equal(other.window.document.querySelector('[data-astra-card]'), null);
  other.window.close();
  const noGrid = boot('https://crm.example.com/app/accounts/7/settings/inboxes/new', '<div>otra pantalla</div>');
  await tick();
  assert.equal(noGrid.window.document.querySelector('[data-astra-card]'), null);
  assert.equal(noGrid.window.document.querySelector('.astra-ov'), null);
  noGrid.window.close();
});

test('clic abre el modal en español con los campos requeridos y valida el teléfono', async () => {
  const dom = boot('https://crm.example.com/app/accounts/7/settings/inboxes/new');
  await tick();
  const d = dom.window.document;
  d.querySelector('[data-astra-card]').click();
  const box = d.querySelector('.astra-md');
  assert.ok(box, 'modal abierto');
  assert.match(box.textContent, /Nombre de la bandeja/);
  assert.match(box.textContent, /Grabar llamadas/);
  assert.match(box.textContent, /Escanear QR/);
  assert.match(box.textContent, /Código de 8 caracteres/);
  d.getElementById('astra-phone').value = '12ab';
  [...box.querySelectorAll('button')].find((b) => b.textContent === 'Conectar').click();
  assert.match(box.querySelector('.astra-err').textContent, /número no es válido/);
  [...box.querySelectorAll('button')].find((b) => b.textContent === 'Cancelar').click();
  assert.equal(d.querySelector('.astra-ov'), null);
  dom.window.close();
});

test('sin cookie de sesión muestra un error claro y no llama al servicio', async () => {
  const dom = boot('https://crm.example.com/app/accounts/7/settings/inboxes/new');
  await tick();
  let called = false;
  dom.window.fetch = () => { called = true; return Promise.reject(new Error('no debe llamarse')); };
  const d = dom.window.document;
  d.querySelector('[data-astra-card]').click();
  d.getElementById('astra-phone').value = '5215512345678';
  [...d.querySelectorAll('.astra-md button')].find((b) => b.textContent === 'Conectar').click();
  await tick(100);
  assert.match(d.querySelector('.astra-md').textContent, /sesión de Chatwoot/);
  assert.equal(called, false);
  dom.window.close();
});

test('flujo completo con cookie devise: envía headers, muestra QR y luego ¡Listo!', async () => {
  const cookie = 'cw_d_session_info=' + encodeURIComponent(JSON.stringify({ 'access-token': 'AT', client: 'CL', uid: 'a@b.c', expiry: '1' }));
  const dom = boot('https://crm.example.com/app/accounts/7/settings/inboxes/new', PAGE, cookie);
  await tick();
  const seen = [];
  let polls = 0;
  dom.window.fetch = (url, opts) => {
    seen.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
    const json = (o, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(o) });
    if (opts.method === 'POST') return json({ provisionId: 'P1' }, 201);
    polls++;
    if (polls === 1) return json({ state: 'qr', qr: '2@abc,def,ghi', inboxId: 55, accountId: 7 });
    return json({ state: 'connected', connectedPhone: '5215512345678', inboxId: 55, accountId: 7 });
  };
  const d = dom.window.document;
  d.querySelector('[data-astra-card]').click();
  d.getElementById('astra-name').value = 'Ventas';
  d.getElementById('astra-phone').value = '+52 55 1234 5678';
  [...d.querySelectorAll('.astra-md button')].find((b) => b.textContent === 'Conectar').click();
  await tick(100);

  assert.equal(seen[0].url, 'https://prov.example.com/provision');
  assert.deepEqual(seen[0].headers['access-token'], 'AT');
  assert.equal(seen[0].headers.client, 'CL');
  assert.equal(seen[0].headers.uid, 'a@b.c');
  const body = JSON.parse(seen[0].body);
  assert.deepEqual(body, { accountId: 7, inboxName: 'Ventas', phone: '525512345678', record: true, method: 'qr' });
  assert.ok(d.querySelector('.astra-qr svg'), 'QR renderizado');
  assert.match(d.querySelector('.astra-md').textContent, /Dispositivos vinculados/);
  // nunca se muestran las llaves
  assert.ok(!d.body.textContent.includes('AT') || !d.querySelector('.astra-md').textContent.includes('access-token'));

  await tick(2300); // siguiente sondeo
  assert.match(d.querySelector('.astra-md').textContent, /¡Listo!/);
  dom.window.close();
});
