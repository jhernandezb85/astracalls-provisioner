/*!
 * connector.js — Tarjeta "WhatsApp + Llamadas" para Chatwoot (Dashboard Scripts)
 * JS puro, sin dependencias. Incluye un generador de códigos QR mínimo embebido.
 *
 * Uso:
 *   <script src="https://provision.example.com/connector.js"
 *           data-provisioner="https://provision.example.com"></script>
 */
(function () {
  'use strict';

  // ======================================================================
  //  Generador QR (modo byte, corrección L, versiones 1–40)
  // ======================================================================
  var ECC_PER_BLOCK_L = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  var NUM_BLOCKS_L = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];

  function utf8Bytes(str) {
    var out = [];
    var s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }
  function rawModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(ver) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK_L[ver] * NUM_BLOCKS_L[ver];
  }
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(deg) {
    var r = [], i, j;
    for (i = 0; i < deg; i++) r.push(0);
    r[deg - 1] = 1;
    var root = 1;
    for (i = 0; i < deg; i++) {
      for (j = 0; j < deg; j++) {
        r[j] = gfMul(r[j], root);
        if (j + 1 < deg) r[j] ^= r[j + 1];
      }
      root = gfMul(root, 2);
    }
    return r;
  }
  function rsRemainder(data, div) {
    var r = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ r.shift();
      r.push(0);
      div.forEach(function (c, i) { r[i] ^= gfMul(c, f); });
    });
    return r;
  }
  function bit(x, i) { return ((x >>> i) & 1) !== 0; }

  /** Devuelve una matriz booleana (true = módulo oscuro). */
  function qrEncode(text) {
    var bytes = utf8Bytes(text), ver, ccBits;
    for (ver = 1; ver <= 40; ver++) {
      ccBits = ver <= 9 ? 8 : 16;
      if (Math.ceil((4 + ccBits + bytes.length * 8) / 8) <= dataCodewords(ver)) break;
    }
    if (ver > 40) throw new Error('Texto demasiado largo para el QR');
    var cap = dataCodewords(ver);

    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, ccBits);
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    for (var pad = 0xec; bits.length < cap * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
      data.push(v);
    }

    // bloques + Reed-Solomon + entrelazado
    var nb = NUM_BLOCKS_L[ver], eccLen = ECC_PER_BLOCK_L[ver];
    var rawCw = Math.floor(rawModules(ver) / 8);
    var shortNum = nb - (rawCw % nb), shortLen = Math.floor(rawCw / nb);
    var blocks = [], div = rsDivisor(eccLen), pos = 0;
    for (var b = 0; b < nb; b++) {
      var dat = data.slice(pos, pos + shortLen - eccLen + (b < shortNum ? 0 : 1));
      pos += dat.length;
      var ecc = rsRemainder(dat, div);
      if (b < shortNum) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var all = [];
    for (var x = 0; x < blocks[0].length; x++) {
      for (var y = 0; y < nb; y++) {
        if (x !== shortLen - eccLen || y >= shortNum) all.push(blocks[y][x]);
      }
    }

    // matriz
    var size = ver * 4 + 17, m = [], fn = [], r, c;
    for (r = 0; r < size; r++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function setFn(px, py, dark) { m[py][px] = dark; fn[py][px] = true; }

    for (i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var align = [];
    if (ver > 1) {
      var na = Math.floor(ver / 7) + 2;
      var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
      align = [6];
      for (var p = size - 7; align.length < na; p -= step) align.splice(1, 0, p);
    }
    align.forEach(function (ay, ii) {
      align.forEach(function (ax, jj) {
        if ((ii === 0 && jj === 0) || (ii === 0 && jj === align.length - 1) || (ii === align.length - 1 && jj === 0)) return;
        for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      });
    });

    function formatBits(mask) {
      var d = (1 << 3) | mask, rem = d; // nivel L = 01
      for (var q = 0; q < 10; q++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var fb = ((d << 10) | rem) ^ 0x5412, q2;
      for (q2 = 0; q2 <= 5; q2++) setFn(8, q2, bit(fb, q2));
      setFn(8, 7, bit(fb, 6)); setFn(8, 8, bit(fb, 7)); setFn(7, 8, bit(fb, 8));
      for (q2 = 9; q2 < 15; q2++) setFn(14 - q2, 8, bit(fb, q2));
      for (q2 = 0; q2 < 8; q2++) setFn(size - 1 - q2, 8, bit(fb, q2));
      for (q2 = 8; q2 < 15; q2++) setFn(8, size - 15 + q2, bit(fb, q2));
      setFn(8, size - 8, true);
    }
    formatBits(0);
    if (ver >= 7) {
      var rm = ver;
      for (i = 0; i < 12; i++) rm = (rm << 1) ^ ((rm >>> 11) * 0x1f25);
      var vb = (ver << 12) | rm;
      for (i = 0; i < 18; i++) {
        var a = size - 11 + (i % 3), bb = Math.floor(i / 3);
        setFn(a, bb, bit(vb, i)); setFn(bb, a, bit(vb, i));
      }
    }

    // datos en zigzag
    var di = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var cx = right - j, up = ((right + 1) & 2) === 0, cy = up ? size - 1 - vert : vert;
          if (!fn[cy][cx] && di < all.length * 8) { m[cy][cx] = bit(all[di >>> 3], 7 - (di & 7)); di++; }
        }
      }
    }

    function applyMask(mask) {
      for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) {
        var inv;
        switch (mask) {
          case 0: inv = (xx + yy) % 2 === 0; break;
          case 1: inv = yy % 2 === 0; break;
          case 2: inv = xx % 3 === 0; break;
          case 3: inv = (xx + yy) % 3 === 0; break;
          case 4: inv = (Math.floor(xx / 3) + Math.floor(yy / 2)) % 2 === 0; break;
          case 5: inv = (xx * yy) % 2 + (xx * yy) % 3 === 0; break;
          case 6: inv = ((xx * yy) % 2 + (xx * yy) % 3) % 2 === 0; break;
          default: inv = ((xx + yy) % 2 + (xx * yy) % 3) % 2 === 0;
        }
        if (!fn[yy][xx] && inv) m[yy][xx] = !m[yy][xx];
      }
    }
    function penalty() {
      var score = 0, line, n, run, t, dark = 0, yy, xx, ii;
      var P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      function scan(get) {
        line = [];
        for (ii = 0; ii < size; ii++) line.push(get(ii) ? 1 : 0);
        run = 1;
        for (ii = 1; ii <= size; ii++) {
          if (ii < size && line[ii] === line[ii - 1]) run++;
          else { if (run >= 5) score += 3 + run - 5; run = 1; }
        }
        for (ii = 0; ii + 11 <= size; ii++) {
          var s1 = true, s2 = true;
          for (t = 0; t < 11; t++) { if (line[ii + t] !== P1[t]) s1 = false; if (line[ii + t] !== P2[t]) s2 = false; }
          if (s1) score += 40;
          if (s2) score += 40;
        }
      }
      for (yy = 0; yy < size; yy++) { (function (row) { scan(function (k) { return m[row][k]; }); })(yy); }
      for (xx = 0; xx < size; xx++) { (function (col) { scan(function (k) { return m[k][col]; }); })(xx); }
      for (yy = 0; yy < size - 1; yy++) for (xx = 0; xx < size - 1; xx++) {
        if (m[yy][xx] === m[yy][xx + 1] && m[yy][xx] === m[yy + 1][xx] && m[yy][xx] === m[yy + 1][xx + 1]) score += 3;
      }
      for (yy = 0; yy < size; yy++) for (xx = 0; xx < size; xx++) if (m[yy][xx]) dark++;
      n = size * size;
      score += Math.floor(Math.abs(dark * 100 / n - 50) / 5) * 10;
      return score;
    }
    var best = 0, bestScore = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      applyMask(mk); formatBits(mk);
      var sc = penalty();
      if (sc < bestScore) { bestScore = sc; best = mk; }
      applyMask(mk);
    }
    applyMask(best); formatBits(best);
    return m;
  }

  function qrToSvg(text, px) {
    var m = qrEncode(text), n = m.length, border = 4, d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      if (m[y][x]) d += 'M' + (x + border) + ',' + (y + border) + 'h1v1h-1z';
    }
    var tot = n + border * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + tot + ' ' + tot + '" width="' + px + '" height="' + px +
      '" shape-rendering="crispEdges" role="img" aria-label="Código QR de WhatsApp"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  // Hook para pruebas unitarias (no hace nada en producción)
  if (typeof window !== 'undefined' && window.__ASTRA_CONNECTOR_TEST__) {
    window.__astraQR = { qrEncode: qrEncode, qrToSvg: qrToSvg };
    return;
  }

  // ======================================================================
  //  Conector
  // ======================================================================
  var script = document.currentScript;
  var PROV = '';
  try {
    PROV = (script && script.getAttribute('data-provisioner')) || (script && new URL(script.src).origin) || '';
  } catch (e) { PROV = ''; }
  PROV = PROV.replace(/\/+$/, '');
  if (!PROV || window.__astraConnectorLoaded) return;
  window.__astraConnectorLoaded = true;

  var PATH_RE = /^\/app\/accounts\/(\d+)\/settings\/inboxes\/new\/?$/;
  var POLL_MS = 2000;
  var CARD_ATTR = 'data-astra-card';

  var CSS = [
    '.astra-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit}',
    '.astra-md{--a-bg:#fff;--a-fg:#1c2024;--a-mut:#60646c;--a-bd:#e0e1e6;--a-in:#fff;--a-ac:#2781f6;--a-err:#d6409f;--a-soft:#f0f0f3;',
    'background:var(--a-bg);color:var(--a-fg);border:1px solid var(--a-bd);border-radius:16px;width:100%;max-width:440px;max-height:92vh;overflow:auto;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.35);font-size:14px;line-height:1.45}',
    '.astra-md.astra-dark{--a-bg:#212225;--a-fg:#edeef0;--a-mut:#b0b4ba;--a-bd:#363a3f;--a-in:#2a2b2f;--a-ac:#3b9eff;--a-err:#ff8dcc;--a-soft:#2e3035}',
    '.astra-md h2{margin:0 0 4px;font-size:18px;font-weight:600;color:var(--a-fg)}',
    '.astra-md p{margin:0 0 12px;color:var(--a-mut)}',
    '.astra-md label.astra-l{display:block;font-weight:500;margin:12px 0 4px;color:var(--a-fg)}',
    '.astra-md input[type=text],.astra-md input[type=tel]{width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;border:1px solid var(--a-bd);background:var(--a-in);color:var(--a-fg);font-size:14px;outline:none}',
    '.astra-md input[type=text]:focus,.astra-md input[type=tel]:focus{border-color:var(--a-ac)}',
    '.astra-md .astra-h{font-size:12px;color:var(--a-mut);margin-top:4px}',
    '.astra-md .astra-ck{display:flex;gap:8px;align-items:center;margin-top:14px;cursor:pointer;color:var(--a-fg)}',
    '.astra-md .astra-opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--a-bd);border-radius:10px;margin-top:8px;cursor:pointer;color:var(--a-fg)}',
    '.astra-md .astra-opt small{display:block;color:var(--a-mut)}',
    '.astra-md .astra-opt.astra-on{border-color:var(--a-ac);background:var(--a-soft)}',
    '.astra-md .astra-row{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}',
    '.astra-md button.astra-b{border:1px solid var(--a-bd);background:var(--a-in);color:var(--a-fg);border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}',
    '.astra-md button.astra-b.astra-pri{background:var(--a-ac);border-color:var(--a-ac);color:#fff}',
    '.astra-md button.astra-b:disabled{opacity:.6;cursor:not-allowed}',
    '.astra-md .astra-err{color:var(--a-err);background:var(--a-soft);border-radius:8px;padding:10px 12px;margin-top:12px}',
    '.astra-md .astra-qr{display:flex;justify-content:center;margin:12px 0}',
    '.astra-md .astra-qr svg{border-radius:10px;border:1px solid var(--a-bd);max-width:100%;height:auto}',
    '.astra-md .astra-code{font:600 28px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:6px;text-align:center;padding:14px;border-radius:10px;background:var(--a-soft);color:var(--a-fg);margin:12px 0;user-select:all}',
    '.astra-md ol{margin:8px 0 0;padding-left:20px;color:var(--a-mut)}',
    '.astra-md .astra-wait{display:flex;align-items:center;gap:8px;color:var(--a-mut);margin-top:12px}',
    '.astra-md .astra-sp{width:14px;height:14px;border-radius:50%;border:2px solid var(--a-bd);border-top-color:var(--a-ac);animation:astra-spin .8s linear infinite}',
    '.astra-md .astra-ok{font-size:44px;text-align:center;margin:4px 0}',
    '.astra-md select{width:auto!important;min-width:0!important;display:inline-block!important;flex:0 0 auto;height:auto!important;margin:0!important;padding:4px 8px;border-radius:6px;border:1px solid var(--a-bd);background:var(--a-in);color:var(--a-fg);font-size:13px}',
    '.astra-md .astra-ind{margin-left:24px;margin-top:2px}',
    '.astra-md.astra-inline{max-width:none;width:auto;max-height:none;overflow:visible;box-shadow:none;margin:32px 0 8px}',
    '.astra-md h3{margin:22px 0 4px;font-size:15px;font-weight:600;color:var(--a-fg)}',
    '.astra-md .astra-pill{display:inline-block;font-size:12px;font-weight:500;padding:2px 10px;border-radius:999px;margin-left:10px;vertical-align:middle;background:var(--a-soft)}',
    '.astra-md .astra-on-t{color:#30a46c}.astra-md .astra-off-t{color:var(--a-err)}',
    '.astra-md .astra-saved{font-size:12px;color:var(--a-mut);margin-top:8px;min-height:16px}',
    '.astra-md .astra-inrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}',
    '.astra-md .astra-inrow input[type=text]{flex:1;min-width:180px;width:auto}',
    '.astra-md table.astra-keys{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}',
    '.astra-md table.astra-keys th,.astra-md table.astra-keys td{padding:7px 8px;border-top:1px solid var(--a-bd);text-align:left;color:var(--a-fg)}',
    '.astra-md table.astra-keys th{color:var(--a-mut);font-weight:500}',
    '.astra-md .astra-secret{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;background:var(--a-soft);color:var(--a-fg);padding:10px 12px;border-radius:8px;margin-top:8px;user-select:all}',
    '.astra-md .astra-warn{border:1px solid var(--a-ac);border-radius:10px;padding:12px;margin-top:12px}',
    '.astra-md code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--a-soft);padding:1px 5px;border-radius:4px}',
    '@keyframes astra-spin{to{transform:rotate(360deg)}}'
  ].join('');

  var ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 21l1.6-4.6A8.5 8.5 0 1 1 8 19.6L3 21z"/><path d="M9.2 8.6c.3 1.9 2.2 4.1 4.3 4.9l1.3-1.2 2 .9c-.2 1-1 1.7-2 1.7-3.3 0-6.5-3.2-6.5-6.4 0-.9.6-1.6 1.6-1.9l.9 2"/></svg>';

  // ---------------- utilidades ----------------
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  /** Lee los headers devise de la cookie de sesión de Chatwoot. Nunca se guardan ni se muestran. */
  function readDevise() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)cw_d_session_info=([^;]*)/);
      if (!m) return null;
      var o = JSON.parse(decodeURIComponent(m[1]));
      if (!o || !o['access-token'] || !o.client || !o.uid) return null;
      return { 'access-token': o['access-token'], client: o.client, uid: o.uid };
    } catch (e) { return null; }
  }

  function isDark() {
    var h = document.documentElement, b = document.body;
    if ((h && (h.classList.contains('dark') || h.getAttribute('data-theme') === 'dark')) || (b && b.classList.contains('dark'))) return true;
    if ((h && h.classList.contains('light')) || (b && b.classList.contains('light'))) return false;
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }

  function api(method, path, body) {
    var d = readDevise();
    if (!d) return Promise.reject(Object.assign(new Error('Tu sesión de Chatwoot no se encontró. Recarga la página e inicia sesión de nuevo.'), { status: 401 }));
    var headers = { 'access-token': d['access-token'], client: d.client, uid: d.uid };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(PROV + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw Object.assign(new Error(j.error || 'Ocurrió un error inesperado.'), { status: r.status, code: j.code });
          return j;
        });
      }, function () { throw Object.assign(new Error('No se pudo conectar con el servicio de conexión. Revisa tu internet e inténtalo de nuevo.'), { status: 0 }); });
  }

  // ---------------- modal ----------------
  var modal = null;

  function closeModal() {
    if (!modal) return;
    modal.stopped = true;
    if (modal.timer) clearTimeout(modal.timer);
    document.removeEventListener('keydown', modal.onKey, true);
    if (modal.root && modal.root.parentNode) modal.root.parentNode.removeChild(modal.root);
    modal = null;
  }

  function openModal(accountId) {
    if (modal) return;
    var ov = el('div', { class: 'astra-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Conectar WhatsApp + Llamadas' });
    var box = el('div', { class: 'astra-md' + (isDark() ? ' astra-dark' : '') });
    ov.appendChild(box);
    document.body.appendChild(ov);
    modal = { root: ov, box: box, accountId: accountId, stopped: false, provisionId: null, timer: null };
    modal.onKey = function (e) { if (e.key === 'Escape' && modal && modal.canEsc) { e.stopPropagation(); closeModal(); } };
    document.addEventListener('keydown', modal.onKey, true);
    renderForm({});
  }

  function setBox(nodes, canEsc) {
    modal.canEsc = !!canEsc;
    modal.box.textContent = '';
    nodes.forEach(function (n) { modal.box.appendChild(n); });
  }

  function renderForm(prev) {
    var method = prev.method || 'qr';
    var name = el('input', { type: 'text', maxlength: '60', value: prev.name || 'WhatsApp', id: 'astra-name', autocomplete: 'off' });
    var phone = el('input', { type: 'tel', value: prev.phone || '', id: 'astra-phone', placeholder: 'Ej. 5215512345678', autocomplete: 'off', inputmode: 'tel' });
    var rec = el('input', { type: 'checkbox', id: 'astra-rec' });
    rec.checked = prev.record !== false;
    var mirror = el('input', { type: 'checkbox', id: 'astra-mirror' });
    mirror.checked = prev.mirrorApi === true;
    var hist = el('input', { type: 'checkbox', id: 'astra-hist' });
    hist.checked = prev.importHistory === true;
    var histDays = daysSelect('astra-hist-days', prev.importHistoryDays || 30);
    histDays.disabled = !hist.checked;
    hist.addEventListener('change', function () { histDays.disabled = !hist.checked; });
    var err = el('div', { class: 'astra-err', style: 'display:none' });
    var optQr = el('label', { class: 'astra-opt' }), optCode = el('label', { class: 'astra-opt' });
    var rQr = el('input', { type: 'radio', name: 'astra-m', value: 'qr' }), rCode = el('input', { type: 'radio', name: 'astra-m', value: 'code' });
    optQr.appendChild(rQr); optQr.appendChild(el('span', null, ['Escanear QR', el('small', { text: 'Escanea un código con la cámara de WhatsApp.' })]));
    optCode.appendChild(rCode); optCode.appendChild(el('span', null, ['Código de 8 caracteres', el('small', { text: 'Escribe un código en WhatsApp (requiere tu número).' })]));
    function sync() {
      method = rCode.checked ? 'code' : 'qr';
      optQr.className = 'astra-opt' + (method === 'qr' ? ' astra-on' : '');
      optCode.className = 'astra-opt' + (method === 'code' ? ' astra-on' : '');
    }
    rQr.checked = method === 'qr'; rCode.checked = method === 'code';
    rQr.addEventListener('change', sync); rCode.addEventListener('change', sync); sync();

    var go = el('button', { class: 'astra-b astra-pri', type: 'button', text: 'Conectar' });
    var cancel = el('button', { class: 'astra-b', type: 'button', text: 'Cancelar', onclick: closeModal });
    go.addEventListener('click', function () {
      var n = name.value.trim(), p = phone.value.trim();
      var digits = p.replace(/\D/g, '');
      var msg = '';
      if (!n) msg = 'Escribe un nombre para la bandeja.';
      else if (p && (digits.length < 8 || digits.length > 15 || !/^\+?[\d\s\-()]+$/.test(p))) msg = 'El número no es válido: usa solo dígitos con código de país (ej. 5215512345678).';
      else if (method === 'code' && !digits) msg = 'Para el código de 8 caracteres necesitas escribir tu número con código de país.';
      if (msg) { err.textContent = msg; err.style.display = ''; return; }
      start({
        name: n, phone: digits, record: rec.checked, method: method,
        mirrorApi: mirror.checked, importHistory: hist.checked, importHistoryDays: Number(histDays.value)
      });
    });

    setBox([
      el('h2', { text: 'WhatsApp + Llamadas' }),
      el('p', { text: 'Conecta tu número de WhatsApp para chatear y recibir/hacer llamadas desde este CRM.' }),
      el('label', { class: 'astra-l', for: 'astra-name', text: 'Nombre de la bandeja' }), name,
      el('label', { class: 'astra-l', for: 'astra-phone', text: 'Número de WhatsApp (con código de país)' }), phone,
      el('div', { class: 'astra-h', text: 'Solo dígitos, sin espacios. Ej.: 5215512345678' }),
      el('label', { class: 'astra-ck' }, [rec, 'Grabar llamadas']),
      el('label', { class: 'astra-ck' }, [hist, 'Importar conversaciones anteriores de los últimos', histDays]),
      el('div', { class: 'astra-h astra-ind', text: 'Llegan como notas privadas, sin reenviar nada a tus contactos. Puede crear muchas conversaciones de golpe.' }),
      el('label', { class: 'astra-ck' }, [mirror, 'Mostrar en el CRM los mensajes enviados por API (ej. n8n)']),
      el('div', { class: 'astra-h astra-ind', text: 'Aparecen como notas privadas para que tu equipo vea lo que envían tus automatizaciones.' }),
      el('div', { class: 'astra-l', text: 'Método de emparejamiento', style: 'margin-top:14px;font-weight:500' }), optQr, optCode,
      err,
      el('div', { class: 'astra-row' }, [cancel, go])
    ], true);
    name.focus();
  }

  function renderError(message, form) {
    var retry = el('button', { class: 'astra-b astra-pri', type: 'button', text: 'Reintentar', onclick: function () { renderForm(form || {}); } });
    setBox([
      el('h2', { text: 'No se pudo completar' }),
      el('div', { class: 'astra-err', text: message }),
      el('div', { class: 'astra-row' }, [el('button', { class: 'astra-b', type: 'button', text: 'Cerrar', onclick: closeModal }), retry])
    ], true);
  }

  function renderLoading(text) {
    setBox([
      el('h2', { text: 'WhatsApp + Llamadas' }),
      el('div', { class: 'astra-wait' }, [el('span', { class: 'astra-sp' }), text])
    ], false);
  }

  function start(form) {
    renderLoading('Creando la conexión…');
    api('POST', '/provision', {
      accountId: modal.accountId, inboxName: form.name, phone: form.phone, record: form.record, method: form.method,
      mirrorApi: !!form.mirrorApi, importHistory: !!form.importHistory, importHistoryDays: form.importHistoryDays || 30
    })
      .then(function (r) {
        if (!modal || modal.stopped) {
          // el usuario cerró mientras se creaba: revertir
          api('DELETE', '/provision/' + encodeURIComponent(r.provisionId)).catch(function () {});
          return;
        }
        modal.provisionId = r.provisionId;
        modal.form = form;
        modal.failures = 0;
        poll();
      })
      .catch(function (e) { if (modal && !modal.stopped) renderError(e.message, form); });
  }

  var lastShown = '';
  function renderPairing(st) {
    var key = st.state + '|' + (st.qr || st.code || '');
    if (key === lastShown) return;
    lastShown = key;
    var nodes = [el('h2', { text: 'Vincula tu WhatsApp' })];
    if (st.state === 'qr') {
      var holder = el('div', { class: 'astra-qr' });
      try { holder.innerHTML = qrToSvg(st.qr, 240); } catch (e) { holder.textContent = 'No se pudo mostrar el QR. Cancela e inténtalo con el código de 8 caracteres.'; }
      nodes.push(el('p', { text: 'Escanea este código QR con tu teléfono:' }), holder,
        el('ol', null, [el('li', { text: 'Abre WhatsApp en tu teléfono.' }), el('li', { text: 'Ve a Dispositivos vinculados → Vincular un dispositivo.' }), el('li', { text: 'Apunta la cámara a este código.' })]));
    } else if (st.state === 'code') {
      nodes.push(el('p', { text: 'Escribe este código en tu teléfono:' }), el('div', { class: 'astra-code', text: String(st.code || '').replace(/(.{4})(?=.)/, '$1-') }),
        el('ol', null, [el('li', { text: 'Abre WhatsApp en tu teléfono.' }), el('li', { text: 'Ve a WhatsApp → Dispositivos vinculados → Vincular con número de teléfono.' }), el('li', { text: 'Escribe el código de 8 caracteres.' })]));
    } else {
      nodes.push(el('div', { class: 'astra-wait' }, [el('span', { class: 'astra-sp' }), 'Preparando el emparejamiento…']));
    }
    if (st.state === 'qr' || st.state === 'code') nodes.push(el('div', { class: 'astra-wait' }, [el('span', { class: 'astra-sp' }), 'Esperando que vincules el dispositivo…']));
    nodes.push(el('div', { class: 'astra-row' }, [el('button', { class: 'astra-b', type: 'button', text: 'Cancelar', onclick: cancelProvision })]));
    setBox(nodes, false);
  }

  function cancelProvision() {
    var id = modal && modal.provisionId;
    lastShown = '';
    if (modal) { modal.stopped = true; if (modal.timer) clearTimeout(modal.timer); }
    if (id) api('DELETE', '/provision/' + encodeURIComponent(id)).catch(function () {});
    closeModal();
  }

  function poll() {
    if (!modal || modal.stopped) return;
    var cur = modal;
    api('GET', '/provision/' + encodeURIComponent(cur.provisionId) + '/status')
      .then(function (st) {
        if (modal !== cur || cur.stopped) return;
        cur.failures = 0;
        if (st.state === 'connected') return renderDone(st);
        if (st.state === 'expired' || st.state === 'cancelled') {
          return renderError(st.state === 'expired' ? 'El tiempo para vincular el dispositivo expiró. Inténtalo de nuevo.' : 'La conexión fue cancelada.', cur.form);
        }
        renderPairing(st);
        cur.timer = setTimeout(poll, POLL_MS);
      })
      .catch(function (e) {
        if (modal !== cur || cur.stopped) return;
        if (e.status === 401 || e.status === 403 || e.status === 404) return renderError(e.status === 404 ? 'La solicitud expiró o ya no existe. Inténtalo de nuevo.' : e.message, cur.form);
        cur.failures++;
        if (cur.failures >= 5) return renderError(e.message, cur.form);
        cur.timer = setTimeout(poll, POLL_MS * 2);
      });
  }

  function renderDone(st) {
    lastShown = '';
    var target = '/app/accounts/' + modal.accountId + '/settings/inboxes/' + encodeURIComponent(st.inboxId);
    var timer = setTimeout(function () { window.location.assign(target); }, 2500);
    setBox([
      el('div', { class: 'astra-ok', text: '✅' }),
      el('h2', { text: '¡Listo!', style: 'text-align:center' }),
      el('p', { text: st.connectedPhone ? 'El número +' + st.connectedPhone + ' quedó conectado a tu CRM.' : 'Tu WhatsApp quedó conectado a tu CRM.', style: 'text-align:center' }),
      el('div', { class: 'astra-row', style: 'justify-content:center' }, [el('button', { class: 'astra-b astra-pri', type: 'button', text: 'Ir a la bandeja', onclick: function () { clearTimeout(timer); window.location.assign(target); } })])
    ], false);
  }

  // ---------------- inyección en la pantalla ----------------
  function ensureStyle() {
    if (document.getElementById('astra-connector-style')) return;
    var s = el('style', { id: 'astra-connector-style' });
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function findGrid() {
    var hs = document.querySelectorAll('h3');
    for (var i = 0; i < hs.length; i++) {
      var btn = hs[i].closest('button');
      var grid = btn && btn.parentElement;
      if (!grid) continue;
      var kids = 0;
      for (var j = 0; j < grid.children.length; j++) if (grid.children[j].tagName === 'BUTTON' && grid.children[j].querySelector('h3')) kids++;
      if (kids >= 3) return grid;
    }
    return null;
  }

  function buildCard(grid, accountId) {
    var tpl = null, i;
    for (i = 0; i < grid.children.length; i++) {
      var c = grid.children[i];
      if (c.tagName === 'BUTTON' && !c.disabled && c.querySelector('h3') && c.querySelector('p') && !c.hasAttribute(CARD_ATTR)) { tpl = c; break; }
    }
    if (!tpl) return null;
    var card = tpl.cloneNode(true);
    card.setAttribute(CARD_ATTR, '1');
    card.removeAttribute('disabled');
    card.setAttribute('type', 'button');
    card.removeAttribute('id');
    // quitar insignias/superposiciones (Beta, "Próximamente", etc.)
    Array.prototype.slice.call(card.querySelectorAll('.absolute')).forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    var h3 = card.querySelector('h3'), p = card.querySelector('p');
    Array.prototype.slice.call(h3.parentElement.children).forEach(function (n) { if (n !== h3) n.parentNode.removeChild(n); });
    h3.textContent = 'WhatsApp + Llamadas';
    h3.style.textTransform = 'none';
    p.textContent = 'Conecta tu número con un QR y recibe y haz llamadas desde el CRM.';
    // icono: primer contenedor circular (o el primer div) de la tarjeta
    var iconBox = card.querySelector('.rounded-full') || card.querySelector('div > div');
    if (iconBox) { iconBox.textContent = ''; iconBox.insertAdjacentHTML('beforeend', ICON_SVG); iconBox.style.color = 'inherit'; }
    card.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      var m = location.pathname.match(PATH_RE);
      if (m) openModal(Number(m[1]));
    });
    return card;
  }

  // ======================================================================
  //  Configuración de una bandeja ya conectada (Ajustes de la bandeja)
  // ======================================================================
  var INBOX_RE = /^\/app\/accounts\/(\d+)\/settings\/inboxes\/(\d+)\/?$/;
  var INBOX_ATTR = 'data-astra-inbox';
  var inboxState = { key: '', status: '', data: null };

  function daysSelect(id, value) {
    var s = el('select', { id: id, 'aria-label': 'Días de historial' });
    [7, 30, 90].forEach(function (d) {
      var o = el('option', { value: String(d), text: d + ' días' });
      if (Number(value) === d) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }

  function copyText(text, btn) {
    var done = function () { var t = btn.textContent; btn.textContent = '¡Copiado!'; setTimeout(function () { btn.textContent = t; }, 1500); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () {}); return; }
    } catch (e) { /* fallback abajo */ }
    var ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* noop */ }
    document.body.removeChild(ta);
  }

  function fmtDate(v) {
    if (!v) return '—';
    try { return new Date(v).toLocaleString(); } catch (e) { return String(v); }
  }

  /**
   * Pestaña "Configuración" de una bandeja API: Chatwoot muestra ahí la casilla
   * #hmacMandatory (id fijo, independiente del idioma). Devuelve el contenedor de
   * esa pestaña (hijo directo de .max-w-7xl) para añadir la tarjeta al final.
   */
  function findConfigTab() {
    var hm = document.getElementById('hmacMandatory');
    if (!hm) return null;
    var node = hm;
    while (node.parentElement && node.parentElement !== document.body) {
      if (node.parentElement.classList && node.parentElement.classList.contains('max-w-7xl')) return node;
      node = node.parentElement;
    }
    return hm.closest('.mx-6') || null;
  }

  function buildInboxCard(accountId, inboxId, data) {
    var card = el('div', { class: 'astra-md astra-inline' + (isDark() ? ' astra-dark' : '') });
    card.setAttribute(INBOX_ATTR, accountId + '/' + inboxId);
    var q = '?accountId=' + accountId + '&inboxId=' + inboxId;

    // ---- opciones ----
    var pill = el('span', {
      class: 'astra-pill ' + (data.connected ? 'astra-on-t' : 'astra-off-t'),
      text: data.connected ? 'Conectado' + (data.phone ? ' · +' + data.phone : '') : 'Desconectado'
    });
    var rec = el('input', { type: 'checkbox' }); rec.checked = !!data.recording;
    var mirror = el('input', { type: 'checkbox' }); mirror.checked = !!data.mirrorApi;
    var hist = el('input', { type: 'checkbox' }); hist.checked = !!data.importHistory;
    var days = daysSelect('astra-inbox-days', data.importHistoryDays || 30);
    var saved = el('div', { class: 'astra-saved' });
    var inputs = [rec, mirror, hist, days];

    function save(patch, revert) {
      inputs.forEach(function (n) { n.disabled = true; });
      saved.className = 'astra-saved'; saved.textContent = 'Guardando…';
      patch.accountId = accountId; patch.inboxId = inboxId;
      api('PUT', '/inbox/settings', patch).then(function (d) {
        data = d; inboxState.data = d;
        saved.textContent = 'Guardado ✓';
      }, function (e) {
        revert();
        saved.className = 'astra-saved astra-err'; saved.textContent = e.message;
      }).then(function () { inputs.forEach(function (n) { n.disabled = false; }); });
    }
    rec.addEventListener('change', function () { save({ recording: rec.checked }, function () { rec.checked = !rec.checked; }); });
    mirror.addEventListener('change', function () { save({ mirrorApi: mirror.checked }, function () { mirror.checked = !mirror.checked; }); });
    hist.addEventListener('change', function () {
      save({ importHistory: hist.checked, importHistoryDays: Number(days.value) }, function () { hist.checked = !hist.checked; });
    });
    var prevDays = days.value;
    days.addEventListener('change', function () {
      var nv = days.value;
      save({ importHistoryDays: Number(nv) }, function () { days.value = prevDays; });
      prevDays = nv;
    });

    // ---- MCP ----
    var keysBox = el('div');
    var created = el('div');
    var keyName = el('input', { type: 'text', maxlength: '60', placeholder: 'Nombre de la llave (ej. Asistente de ventas)' });
    var ro = el('input', { type: 'checkbox' });
    var mcpErr = el('div', { class: 'astra-err', style: 'display:none' });
    var createBtn = el('button', { class: 'astra-b astra-pri', type: 'button', text: 'Crear llave' });

    function loadKeys() {
      keysBox.textContent = '';
      keysBox.appendChild(el('div', { class: 'astra-wait' }, [el('span', { class: 'astra-sp' }), 'Cargando llaves…']));
      api('GET', '/inbox/mcp-keys' + q).then(function (r) {
        keysBox.textContent = '';
        if (!r.keys.length) { keysBox.appendChild(el('p', { text: 'Todavía no hay llaves para esta bandeja.', style: 'margin-top:10px' })); return; }
        var tb = el('tbody');
        r.keys.forEach(function (k) {
          var rm = el('button', { class: 'astra-b', type: 'button', text: 'Revocar' });
          rm.addEventListener('click', function () {
            if (!window.confirm('¿Revocar la llave "' + (k.name || k.prefix) + '"? La IA que la use dejará de funcionar.')) return;
            rm.disabled = true;
            api('DELETE', '/inbox/mcp-keys/' + encodeURIComponent(k.id) + q).then(loadKeys, function (e) {
              rm.disabled = false; mcpErr.textContent = e.message; mcpErr.style.display = '';
            });
          });
          tb.appendChild(el('tr', null, [
            el('td', { text: k.name || '—' }),
            el('td', null, [el('code', { text: (k.prefix || '') + '…' })]),
            el('td', { text: k.readOnly ? 'Solo lectura' : 'Lectura y envío' }),
            el('td', { text: fmtDate(k.lastUsedAt) }),
            el('td', { style: 'text-align:right' }, [rm])
          ]));
        });
        keysBox.appendChild(el('table', { class: 'astra-keys' }, [
          el('thead', null, [el('tr', null, [el('th', { text: 'Nombre' }), el('th', { text: 'Llave' }), el('th', { text: 'Permiso' }), el('th', { text: 'Último uso' }), el('th')])]),
          tb
        ]));
      }, function (e) {
        keysBox.textContent = '';
        keysBox.appendChild(el('div', { class: 'astra-err', text: e.message }));
      });
    }

    createBtn.addEventListener('click', function () {
      mcpErr.style.display = 'none';
      createBtn.disabled = true;
      api('POST', '/inbox/mcp-keys', { accountId: accountId, inboxId: inboxId, name: keyName.value.trim(), readOnly: ro.checked })
        .then(function (r) {
          keyName.value = ''; ro.checked = false;
          var cUrl = el('button', { class: 'astra-b astra-pri', type: 'button', text: 'Copiar URL' });
          var cKey = el('button', { class: 'astra-b', type: 'button', text: 'Copiar solo la llave' });
          var hide = el('button', { class: 'astra-b', type: 'button', text: 'Ya la guardé' });
          cUrl.addEventListener('click', function () { copyText(r.url, cUrl); });
          cKey.addEventListener('click', function () { copyText(r.secret, cKey); });
          hide.addEventListener('click', function () { created.textContent = ''; });
          created.textContent = '';
          created.appendChild(el('div', { class: 'astra-warn' }, [
            el('strong', { text: 'Llave creada. Cópiala ahora: no se volverá a mostrar.' }),
            el('div', { class: 'astra-secret', text: r.url }),
            el('div', { class: 'astra-h', text: 'Si tu IA pide servidor y llave por separado: servidor ' + r.endpoint + ' con el encabezado "Authorization: Bearer <llave>".' }),
            el('div', { class: 'astra-inrow' }, [cUrl, cKey, hide])
          ]));
          loadKeys();
        }, function (e) { mcpErr.textContent = e.message; mcpErr.style.display = ''; })
        .then(function () { createBtn.disabled = false; });
    });

    [
      el('h2', null, ['WhatsApp + Llamadas', pill]),
      el('p', { text: 'Opciones de esta bandeja en AstraCalls. Los cambios se guardan al instante.' }),
      el('label', { class: 'astra-ck' }, [rec, 'Grabar llamadas']),
      el('label', { class: 'astra-ck' }, [mirror, 'Mostrar en el CRM los mensajes enviados por API (ej. n8n)']),
      el('div', { class: 'astra-h astra-ind', text: 'Aparecen como notas privadas para que tu equipo vea lo que envían tus automatizaciones.' }),
      el('label', { class: 'astra-ck' }, [hist, 'Importar conversaciones anteriores de los últimos', days]),
      el('div', { class: 'astra-h astra-ind', text: 'Solo aplica la próxima vez que se vincule el número (WhatsApp envía el historial al vincular).' }),
      saved,
      el('h3', { text: 'Conectar tu IA (MCP)' }),
      el('p', { text: 'Crea una llave para que un asistente de IA (Claude, ChatGPT, n8n…) use este número: leer y enviar mensajes, ver contactos y hacer llamadas. Cada llave solo da acceso a este número y no permite desconectarlo ni cambiar su configuración.' }),
      el('div', { class: 'astra-h', text: 'Servidor MCP: ' + (data.mcpEndpoint || '') }),
      el('div', { class: 'astra-inrow' }, [keyName, el('label', { class: 'astra-ck', style: 'margin-top:0' }, [ro, 'Solo lectura']), createBtn]),
      mcpErr,
      created,
      keysBox
    ].forEach(function (n) { card.appendChild(n); });
    loadKeys();
    return card;
  }

  function removeInboxCards() {
    Array.prototype.slice.call(document.querySelectorAll('[' + INBOX_ATTR + ']')).forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
  }

  function tryInjectInbox() {
    var m = location.pathname.match(INBOX_RE);
    if (!m) { removeInboxCards(); inboxState = { key: '', status: '', data: null }; return; }
    var accountId = Number(m[1]), inboxId = Number(m[2]), key = accountId + '/' + inboxId;
    var tab = findConfigTab(); // solo existe en la pestaña "Configuración" de una bandeja API
    if (!tab) { removeInboxCards(); return; }
    if (inboxState.key !== key) {
      inboxState = { key: key, status: 'loading', data: null };
      api('GET', '/inbox/settings?accountId=' + accountId + '&inboxId=' + inboxId).then(function (d) {
        if (inboxState.key !== key) return;
        inboxState.status = d && d.managed ? 'managed' : 'unmanaged';
        inboxState.data = d;
        schedule();
      }, function () {
        if (inboxState.key !== key) return;
        inboxState.status = 'unmanaged'; // 404, sin sesión o error: no mostrar nada
      });
      return;
    }
    if (inboxState.status !== 'managed') return;
    var existing = document.querySelector('[' + INBOX_ATTR + ']');
    if (existing && existing.getAttribute(INBOX_ATTR) === key && tab.contains(existing)) return;
    removeInboxCards();
    ensureStyle();
    tab.appendChild(buildInboxCard(accountId, inboxId, inboxState.data)); // al final de "Configuración"
  }

  function tryInject() {
    try { tryInjectInbox(); } catch (e) { /* nunca romper la pantalla de Chatwoot */ }
    try {
      var m = location.pathname.match(PATH_RE);
      if (!m) return;
      var grid = findGrid();
      if (!grid || grid.querySelector('[' + CARD_ATTR + ']')) return;
      var card = buildCard(grid, Number(m[1]));
      if (!card) return;
      ensureStyle();
      grid.appendChild(card);
    } catch (e) { /* nunca romper la pantalla de Chatwoot */ }
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var run = function () { scheduled = false; try { tryInject(); } catch (e) { /* noop */ } };
    (window.requestAnimationFrame || setTimeout)(run);
  }

  // Cambios de ruta en la SPA
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    if (typeof orig !== 'function') return;
    history[fn] = function () {
      var r = orig.apply(this, arguments);
      try { window.dispatchEvent(new Event('astra:route')); } catch (e) { /* noop */ }
      return r;
    };
  });
  window.addEventListener('astra:route', schedule);
  window.addEventListener('popstate', schedule);

  function boot() {
    try {
      new MutationObserver(function () {
        try {
          var p = window.location.pathname;
          if (PATH_RE.test(p) || INBOX_RE.test(p) || document.querySelector('[' + INBOX_ATTR + ']')) schedule();
        } catch (e) { /* ventana cerrada */ }
      })
        .observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* noop */ }
    schedule();
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
