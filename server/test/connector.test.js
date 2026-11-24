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

// ---------- configuración de una bandeja ya conectada ----------
const COOKIE = 'cw_d_session_info=' + encodeURIComponent(JSON.stringify({ 'access-token': 'AT', client: 'CL', uid: 'a@b.c' }));
// pestaña "Configuración" de una bandeja API (marcado de ConfigurationPage.vue)
const SETTINGS_PAGE = () => `<div class="grid settings"><header>Prueba</header>
  <section class="w-full overflow-auto py-8"><div class="max-w-7xl mx-auto w-full">
    <div class="mx-6 max-w-4xl" id="cfgtab"><div>
      <div><label>Inbox Identifier</label><pre>quKPcQRC1ZDr5BhQYacjhpuM</pre></div>
      <div class="flex gap-2 items-center"><input id="hmacMandatory" type="checkbox"><label for="hmacMandatory">HMAC</label></div>
    </div></div>
  </div></section></div>`;
// pestaña "Ajustes" (tiene el webhook, pero NO la casilla HMAC)
const AJUSTES_PAGE = `<section class="w-full overflow-auto py-8"><div class="max-w-7xl mx-auto w-full">
  <div class="flex mx-6"><label>URL de Webhook</label><input value="https://calls.example.com/api/sessions/abc/chatwoot/webhook"></div>
</div></section>`;

function mockApi(dom, routes) {
  const calls = [];
  dom.window.fetch = (url, opts) => {
    const u = new URL(url);
    const key = opts.method + ' ' + u.pathname;
    calls.push({ key, url, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers });
    const h = routes[key];
    const [status, json] = h ? h(u, opts) : [404, { error: 'no' }];
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(json) });
  };
  return calls;
}

const MANAGED = { managed: true, connected: true, phone: '5358310867', recording: true, mirrorApi: false, deviceMode: 'keep', deviceBot: true, readReceipts: false, contactDelete: 'delete', importHistory: false, importHistoryDays: 30, mcpEndpoint: 'https://calls.example.com/mcp' };

test('ajustes de bandeja: muestra la tarjeta, guarda opciones y gestiona llaves MCP', async () => {
  const dom = boot('https://crm.example.com/app/accounts/1/settings/inboxes/38/configuration', SETTINGS_PAGE(), COOKIE);
  let keys = [];
  const calls = mockApi(dom, {
    'GET /inbox/settings': () => [200, MANAGED],
    'PUT /inbox/settings': (u, o) => [200, { ...MANAGED, ...JSON.parse(o.body) }],
    'GET /inbox/mcp-keys': () => [200, { endpoint: 'https://calls.example.com/mcp', max: 1, keys }],
    'POST /inbox/mcp-keys': (u, o) => {
      const b = JSON.parse(o.body);
      keys = [{ id: 'k1', name: b.name, prefix: 'acmcp_abc123', readOnly: b.readOnly, createdAt: '2026-11-23T00:00:00Z' }];
      return [201, { key: keys[0], secret: 'acmcp_SECRETO', endpoint: 'https://calls.example.com/mcp', url: 'https://calls.example.com/mcp/acmcp_SECRETO' }];
    },
  });
  const d = dom.window.document;
  // dispara el observador
  d.body.appendChild(d.createElement('i'));
  await tick(150);

  const card = d.querySelector('[data-astra-inbox="1/38"]');
  assert.ok(card, 'tarjeta insertada');
  assert.equal(d.getElementById('cfgtab').lastElementChild, card, 'al final de la pestaña Configuración');
  assert.match(card.textContent, /Conectado · \+5358310867/);
  assert.match(card.textContent, /Conectar tu IA \(MCP\)/);
  assert.equal(calls.find((c) => c.key === 'GET /inbox/settings').url, 'https://prov.example.com/inbox/settings?accountId=1&inboxId=38');
  assert.match(card.textContent, /sin abrir conversaciones pendientes/);
  assert.match(card.textContent, /checks de entregado y leído/);
  assert.match(card.textContent, /Lo que escribes desde el celular entra/);
  assert.match(card.textContent, /Captain deja de responder/);
  const radios = [...card.querySelectorAll('input[type=radio][name^="astra-devmode"]')];
  assert.deepEqual(radios.map((r) => r.value), ['open', 'keep', 'note']);
  assert.equal(radios.find((r) => r.checked).value, 'keep', 'muestra la opción guardada');
  const delRadios = [...card.querySelectorAll('input[type=radio][name^="astra-delmode"]')];
  assert.deepEqual(delRadios.map((r) => r.value), ['note', 'delete']);
  assert.equal(delRadios.find((r) => r.checked).value, 'delete', 'muestra la opción guardada');
  assert.doesNotMatch(card.textContent, /No se pudo preparar el bot/, 'con bot no hay aviso');
  const aviso = card.querySelector('a[href="https://prov.example.com/aviso-ia"]');
  assert.ok(aviso, 'enlace al aviso');
  assert.equal(aviso.getAttribute('target'), '_blank');

  // guardar una opción
  const boxFor = (re) => [...card.querySelectorAll('label')].find((l) => re.test(l.textContent)).querySelector('input');
  const mirrorBox = boxFor(/enviados por API/);
  mirrorBox.checked = true; mirrorBox.dispatchEvent(new dom.window.Event('change'));
  await tick(80);
  const put = calls.find((c) => c.key === 'PUT /inbox/settings');
  assert.deepEqual(put.body, { mirrorApi: true, accountId: 1, inboxId: 38 });
  const ticksBox = boxFor(/checks de entregado/);
  ticksBox.checked = true; ticksBox.dispatchEvent(new dom.window.Event('change'));
  await tick(80);
  assert.ok(calls.some((c) => c.key === 'PUT /inbox/settings' && c.body.readReceipts === true));
  assert.match(card.textContent, /Guardado ✓/);
  const note = radios.find((r) => r.value === 'note');
  note.checked = true; note.dispatchEvent(new dom.window.Event('change'));
  await tick(80);
  assert.ok(calls.some((c) => c.key === 'PUT /inbox/settings' && c.body.deviceMode === 'note'));
  const keepNote = delRadios.find((r) => r.value === 'note');
  keepNote.checked = true; keepNote.dispatchEvent(new dom.window.Event('change'));
  await tick(80);
  assert.ok(calls.some((c) => c.key === 'PUT /inbox/settings' && c.body.contactDelete === 'note'));
  const adsBox = boxFor(/datos de los anuncios/);
  assert.equal(adsBox.checked, false, 'apagada por defecto');
  adsBox.checked = true; adsBox.dispatchEvent(new dom.window.Event('change'));
  await tick(80);
  assert.ok(calls.some((c) => c.key === 'PUT /inbox/settings' && c.body.adAttributes === true));

  // crear llave MCP: el botón está bloqueado hasta aceptar el aviso
  const createBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Crear llave');
  assert.equal(createBtn.disabled, true, 'sin aceptar el aviso no se puede crear');
  const accept = [...card.querySelectorAll('label')].find((l) => /Leí y acepto/.test(l.textContent)).querySelector('input');
  accept.checked = true; accept.dispatchEvent(new dom.window.Event('change'));
  assert.equal(createBtn.disabled, false);
  card.querySelector('input[type=text]').value = 'Mi bot';
  createBtn.click();
  await tick(150);
  assert.deepEqual(calls.find((c) => c.key === 'POST /inbox/mcp-keys').body, { accountId: 1, inboxId: 38, name: 'Mi bot', readOnly: false });
  assert.equal(card.querySelector('.astra-secret').textContent, 'https://calls.example.com/mcp/acmcp_SECRETO');
  assert.match(card.textContent, /no podrás volver a verla ni crear otra/);
  assert.match(card.querySelector('table.astra-keys').textContent, /Mi bot/);

  // con la llave ya creada: no se puede crear otra ni revocar desde Chatwoot
  assert.equal(createBtn.closest('div[style]').style.display, 'none', 'formulario oculto');
  assert.ok(![...card.querySelectorAll('button')].some((b) => b.textContent === 'Revocar'));
  assert.match(card.textContent, /contacta a soporte/);
  dom.window.close();
});

test('ajustes de bandeja: no hace nada si la bandeja no es de AstraCalls o en otra pestaña', async () => {
  const notManaged = boot('https://crm.example.com/app/accounts/1/settings/inboxes/5', SETTINGS_PAGE(), COOKIE);
  mockApi(notManaged, { 'GET /inbox/settings': () => [404, { error: 'Esta bandeja no está conectada', code: 'not_managed' }] });
  notManaged.window.document.body.appendChild(notManaged.window.document.createElement('i'));
  await tick(120);
  assert.equal(notManaged.window.document.querySelector('[data-astra-inbox]'), null);
  notManaged.window.close();

  const otherTab = boot('https://crm.example.com/app/accounts/1/settings/inboxes/38', AJUSTES_PAGE, COOKIE);
  const calls = mockApi(otherTab, { 'GET /inbox/settings': () => [200, MANAGED] });
  otherTab.window.document.body.appendChild(otherTab.window.document.createElement('i'));
  await tick(120);
  assert.equal(otherTab.window.document.querySelector('[data-astra-inbox]'), null);
  assert.equal(calls.length, 0, 'ni siquiera consulta');
  otherTab.window.close();
});

test('el modal envía historial y espejo de API', async () => {
  const dom = boot('https://crm.example.com/app/accounts/7/settings/inboxes/new', PAGE, COOKIE);
  await tick();
  const calls = mockApi(dom, { 'POST /provision': () => [500, { error: 'x' }] });
  const d = dom.window.document;
  d.querySelector('[data-astra-card]').click();
  d.getElementById('astra-phone').value = '5215512345678';
  d.getElementById('astra-hist').checked = true;
  d.getElementById('astra-hist').dispatchEvent(new dom.window.Event('change'));
  d.getElementById('astra-hist-days').value = '90';
  d.getElementById('astra-mirror').checked = true;
  [...d.querySelectorAll('.astra-md button')].find((b) => b.textContent === 'Conectar').click();
  await tick(80);
  const b = calls[0].body;
  assert.equal(b.importHistory, true);
  assert.equal(b.importHistoryDays, 90);
  assert.equal(b.mirrorApi, true);
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
  assert.deepEqual(body, {
    accountId: 7, inboxName: 'Ventas', phone: '525512345678', record: true, method: 'qr',
    mirrorApi: false, importHistory: false, importHistoryDays: 30,
  });
  assert.ok(d.querySelector('.astra-qr svg'), 'QR renderizado');
  assert.match(d.querySelector('.astra-md').textContent, /Dispositivos vinculados/);
  // nunca se muestran las llaves
  assert.ok(!d.body.textContent.includes('AT') || !d.querySelector('.astra-md').textContent.includes('access-token'));

  await tick(2300); // siguiente sondeo
  assert.match(d.querySelector('.astra-md').textContent, /¡Listo!/);
  dom.window.close();
});
