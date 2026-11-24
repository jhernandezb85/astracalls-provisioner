'use strict';

const { load, validate } = require('./config');
const { makeLogger } = require('./util');
const { ChatwootClient } = require('./chatwoot');
const { AstraCallsClient } = require('./astracalls');
const { Provisioner } = require('./provisioner');
const { createApp } = require('./app');
const path = require('node:path');
const { CapiStore, CapiSender } = require('./capi');

const cfg = load();
const log = makeLogger();
try {
  validate(cfg);
} catch (e) {
  log.error(e.message);
  process.exit(1);
}

const chatwoot = new ChatwootClient({ baseUrl: cfg.chatwootUrl, timeoutMs: cfg.httpTimeoutMs });
const astracalls = new AstraCallsClient({
  baseUrl: cfg.astracallsUrl, apiKey: cfg.astracallsApiKey, publicUrl: cfg.astracallsPublicUrl,
  timeoutMs: cfg.httpTimeoutMs, log,
});
const capiStore = new CapiStore({ file: path.join(cfg.dataDir, 'capi.json'), secret: cfg.capiSecret });
if (!capiStore.ready) log.warn('CAPI_SECRET no configurado: la conexión con Meta queda desactivada');
const capiSender = new CapiSender({ store: capiStore, cw: chatwoot, log });
const provisioner = new Provisioner({ cfg, chatwoot, astracalls, log, capiStore, capiSender });
provisioner.start();
astracalls.startWatching();

const app = createApp({ cfg, provisioner, log, capiSender });
const server = app.listen(cfg.port, () => log.info('provisioner escuchando', { port: cfg.port }));

function shutdown() {
  astracalls.stopWatching();
  provisioner.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
