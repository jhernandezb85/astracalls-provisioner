'use strict';

const http = require('node:http');
const { load } = require('../src/config');
const { ChatwootClient } = require('../src/chatwoot');
const { AstraCallsClient } = require('../src/astracalls');
const { Provisioner } = require('../src/provisioner');
const { createApp } = require('../src/app');

const SECRET_API_KEY = 'SUPER-SECRET-MASTER-KEY';
const USER_TOKEN = 'USER-API-TOKEN-123';
const DEVISE = { 'access-token': 'devise-at-xyz', client: 'devise-client', uid: 'admin@example.com' };

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : undefined); } catch { resolve(undefined); } });
  });
}

/** Chatwoot simulado. users: uid -> {id, role, accountId, token} */
async function mockChatwoot(opts = {}) {
  const state = {
    calls: [], inboxes: new Map(), nextInbox: 100, failCreate: false, bots: [], failBots: false, attrDefs: [], failAttrs: false,
    users: opts.users || { 'admin@example.com': { id: 1, role: 'administrator', accountId: 7, token: USER_TOKEN } },
  };
  const { server, url } = await listen(async (req, res) => {
    const body = await readBody(req);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    state.calls.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (req.method === 'GET' && req.url === '/api/v1/profile') {
      const u = state.users[req.headers.uid];
      if (!u || req.headers['access-token'] !== DEVISE['access-token']) return send(401, { errors: ['bad'] });
      return send(200, { id: u.id, uid: req.headers.uid, access_token: u.token, accounts: [{ id: u.accountId, name: 'Acme', role: u.role }] });
    }
    let m;
    if (req.method === 'GET' && /^\/api\/v1\/accounts\/\d+\/inboxes$/.test(req.url)) {
      const payload = [...state.inboxes].map(([id, b]) => ({ id, name: b.name, channel_type: b.channelType || 'Channel::Api', webhook_url: b.channel.webhook_url }));
      payload.push(...(state.extraInboxes || []));
      return send(200, { payload });
    }
    if (req.method === 'POST' && (m = req.url.match(/^\/api\/v1\/accounts\/(\d+)\/inboxes$/))) {
      if (req.headers.api_access_token !== USER_TOKEN) return send(401, {});
      if (state.failCreate) return send(500, {});
      const id = state.nextInbox++;
      state.inboxes.set(id, body);
      return send(200, { id, name: body.name, inbox_identifier: 'ident-' + id });
    }
    if (req.method === 'GET' && (m = req.url.match(/^\/api\/v1\/accounts\/(\d+)\/inboxes\/(\d+)$/))) {
      if (req.headers.api_access_token !== USER_TOKEN) return send(401, {});
      const b = state.inboxes.get(Number(m[2]));
      if (!b) return send(404, {});
      return send(200, { id: Number(m[2]), name: b.name, channel_type: b.channelType || 'Channel::Api', webhook_url: b.channel.webhook_url, inbox_identifier: 'ident-' + m[2] });
    }
    if (req.method === 'PATCH' && (m = req.url.match(/^\/api\/v1\/accounts\/(\d+)\/inboxes\/(\d+)$/))) {
      if (req.headers.api_access_token !== USER_TOKEN) return send(401, {});
      const b = state.inboxes.get(Number(m[2]));
      if (!b) return send(404, {});
      if (body && body.channel && 'webhook_url' in body.channel) b.channel.webhook_url = body.channel.webhook_url;
      return send(200, { id: Number(m[2]) });
    }
    // atributos personalizados de la cuenta
    if ((m = req.url.match(/^\/api\/v1\/accounts\/(\d+)\/custom_attribute_definitions(?:\?.*)?$/))) {
      if (req.headers.api_access_token !== USER_TOKEN) return send(401, {});
      if (state.failAttrs) return send(500, {});
      const acct = Number(m[1]);
      if (req.method === 'GET') return send(200, state.attrDefs.filter((d) => d.account_id === acct));
      if (req.method === 'POST') {
        const d = { id: state.attrDefs.length + 1, account_id: acct, attribute_key: body.attribute_key, attribute_model: body.attribute_model, attribute_display_name: body.attribute_display_name, attribute_display_type: body.attribute_display_type };
        state.attrDefs.push(d);
        return send(200, d);
      }
    }
    // Agent Bots de la cuenta (como Chatwoot: el token se entrega a administradores)
    if ((m = req.url.match(/^\/api\/v1\/accounts\/(\d+)\/agent_bots(?:\/(\d+))?$/))) {
      if (req.headers.api_access_token !== USER_TOKEN) return send(401, {});
      if (state.failBots) return send(500, {});
      const acct = Number(m[1]);
      const view = (b) => ({ id: b.id, name: b.name, account_id: b.account_id, system_bot: !b.account_id, access_token: { token: b.token } });
      if (req.method === 'GET' && !m[2]) return send(200, state.bots.filter((b) => !b.account_id || b.account_id === acct).map(view));
      if (req.method === 'GET') { const b = state.bots.find((x) => x.id === Number(m[2])); return b ? send(200, view(b)) : send(404, {}); }
      if (req.method === 'POST' && !m[2]) {
        const b = { id: state.bots.length + 1, name: body.name, account_id: acct, token: 'BOT-TOKEN-' + (state.bots.length + 1) };
        state.bots.push(b);
        return send(200, view(b));
      }
    }
    if (req.method === 'DELETE' && (m = req.url.match(/^\/api\/v1\/accounts\/(\d+)\/inboxes\/(\d+)$/))) {
      state.inboxes.delete(Number(m[2]));
      return send(200, {});
    }
    send(404, {});
  });
  return { state, url, close: () => server.close() };
}

/** AstraCalls simulado. fail: nombre de operación que debe fallar con 500. */
async function mockAstraCalls(opts = {}) {
  const state = { calls: [], sessions: new Map(), next: 1, fail: opts.fail || null, authKeyOk: true };
  const { server, url } = await listen(async (req, res) => {
    const body = await readBody(req);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (req.headers['x-api-key'] !== SECRET_API_KEY) { state.authKeyOk = false; return send(401, { error: 'unauthorized' }); }
    if (req.url.startsWith('/api/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      state.sse = res;
      res.write(`data: ${JSON.stringify({ type: 'session-list', sessions: [] })}\n\n`);
      return;
    }
    let op = null; let m;
    if (req.method === 'POST' && req.url === '/api/sessions') op = 'createSession';
    else if (req.method === 'GET' && req.url === '/api/sessions') op = 'list';
    else if ((m = req.url.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/))) {
      const sub = m[2] || '';
      if (req.method === 'DELETE' && !sub) op = 'deleteSession';
      else if (req.method === 'POST' && sub === 'chatwoot') op = 'setChatwoot';
      else if (req.method === 'GET' && sub === 'chatwoot') op = 'getChatwoot';
      else if (req.method === 'PUT' && sub === 'recording') op = 'setRecording';
      else if (req.method === 'GET' && sub === 'recording') op = 'getRecording';
      else if (req.method === 'GET' && sub === 'mcp-keys') op = 'listMcp';
      else if (req.method === 'POST' && sub === 'mcp-keys') op = 'createMcp';
      else if (req.method === 'DELETE' && sub.startsWith('mcp-keys/')) op = 'deleteMcp';
      else if (req.method === 'POST' && sub === 'pair') op = 'pair';
      else if (req.method === 'POST' && sub === 'pair-code') op = 'pairCode';
    }
    state.calls.push({ op, method: req.method, path: req.url, body });
    if (!op) return send(404, {});
    if (state.fail === op) return send(500, { error: 'boom ' + op });
    if (op === 'createSession') { const id = 'sess' + state.next++; state.sessions.set(id, { name: body.name }); return send(200, { id }); }
    if (op === 'list') return send(200, { sessions: [...state.sessions].map(([id, s]) => ({ id, name: s.name, state: s.state || 'connecting', paired: !!s.paired, jid: s.jid || '' })) });
    if (op === 'deleteSession') { state.sessions.delete(m[1]); return send(204); }
    const sess = m && state.sessions.get(m[1]);
    if (m && !sess && op !== 'deleteSession') return send(404, { error: 'no session' });
    if (op === 'pairCode') return send(200, { code: 'ABCD1234' });
    if (op === 'setChatwoot') {
      // igual que AstraCalls: parte de la config actual y conserva el token si viene vacío
      const cur = sess.chatwoot || {};
      const next = { ...cur, ...body };
      if (!body.account_token) next.account_token = cur.account_token;
      if (!body.device_bot_token) next.device_bot_token = cur.device_bot_token;
      sess.chatwoot = next;
      return send(200, { chatwoot: { ...next, account_token: '', device_bot_token: '' }, device_bot: !!next.device_bot_token });
    }
    if (op === 'getChatwoot') {
      const c = sess.chatwoot || {};
      return send(200, { chatwoot: { ...c, account_token: '', device_bot_token: '' }, device_bot: !!c.device_bot_token });
    }
    if (op === 'setRecording') { sess.recording = !!(body && body.enabled); return send(200, { enabled: sess.recording }); }
    if (op === 'getRecording') return send(200, { enabled: !!sess.recording });
    if (op === 'listMcp') return send(200, { keys: (sess.mcp || []).map(({ secret, ...k }) => k), max: 20, endpoint: 'https://calls.example.com/mcp' });
    if (op === 'createMcp') {
      sess.mcp = sess.mcp || [];
      const id = 'k' + (sess.mcp.length + 1);
      const secret = 'acmcp_' + 'f'.repeat(56) + id;
      const key = { id, sessionId: m[1], name: body.name, prefix: secret.slice(0, 12), readOnly: !!body.readOnly, createdAt: '2026-11-23T00:00:00Z' };
      sess.mcp.push({ ...key, secret });
      return send(201, { key, secret, endpoint: 'https://calls.example.com/mcp', url: 'https://calls.example.com/mcp/' + secret });
    }
    if (op === 'deleteMcp') {
      const kid = m[2].split('/')[1];
      const before = (sess.mcp || []).length;
      sess.mcp = (sess.mcp || []).filter((k) => k.id !== kid);
      return before === sess.mcp.length ? send(404, { error: 'chave não encontrada' }) : send(200, { deleted: true });
    }
    if (op === 'setRecording') return send(200, { enabled: !!(body && body.enabled) });
    return send(204);
  });
  return { state, url, close: () => { if (state.sse) state.sse.end(); server.closeAllConnections && server.closeAllConnections(); server.close(); } };
}

/** Monta todo el sistema contra los mocks. */
async function setup({ cwOpts, acOpts, env } = {}) {
  const cw = await mockChatwoot(cwOpts);
  const ac = await mockAstraCalls(acOpts);
  const logs = [];
  const log = {
    info: (m, meta) => logs.push(['info', m, meta]),
    warn: (m, meta) => logs.push(['warn', m, meta]),
    error: (m, meta) => logs.push(['error', m, meta]),
  };
  const cfg = load({
    ASTRACALLS_URL: ac.url, ASTRACALLS_API_KEY: SECRET_API_KEY, ASTRACALLS_PUBLIC_URL: 'https://calls.example.com',
    CHATWOOT_URL: cw.url, ALLOWED_ORIGIN: 'https://crm.example.com', HTTP_TIMEOUT_MS: '2000', ...(env || {}),
  });
  const chatwoot = new ChatwootClient({ baseUrl: cfg.chatwootUrl, timeoutMs: cfg.httpTimeoutMs });
  const astracalls = new AstraCallsClient({ baseUrl: cfg.astracallsUrl, apiKey: cfg.astracallsApiKey, publicUrl: cfg.astracallsPublicUrl, timeoutMs: cfg.httpTimeoutMs, log });
  const provisioner = new Provisioner({ cfg, chatwoot, astracalls, log });
  const app = createApp({ cfg, provisioner, log });
  const { server, url } = await listen(app);
  const call = (method, path, { body, headers, devise = DEVISE, origin = 'https://crm.example.com' } = {}) =>
    fetch(url + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(devise || {}), ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, headers: r.headers, json: await r.json().catch(() => null) }));
  return {
    cw, ac, cfg, logs, astracalls, provisioner, call,
    async close() { app.close(); astracalls.stopWatching(); provisioner.stop(); server.close(); cw.close(); ac.close(); },
  };
}

module.exports = { setup, DEVISE, USER_TOKEN, SECRET_API_KEY };
