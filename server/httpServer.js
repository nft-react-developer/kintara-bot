// ============ OPTIONAL HTTP SERVER ============
// Starts a small read-only Express server when enabled from configuration.
const path = require('path');
const express = require('express');
const { config } = require('../config');
const { createDashboardApi } = require('./dashboardApi');

function startHttpServer({ logger = console.log } = {}) {
  if (!config.expressServerEnabled) return null;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'kintara-bot',
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.use('/api', createDashboardApi());
  app.use(express.static(path.join(__dirname, 'public')));

  const server = app.listen(config.expressServerPort, () => {
    logger(`[http] server listening on port ${config.expressServerPort}`);
  });

  server.on('error', (err) => {
    logger(`[http] server error: ${err.message}`);
  });

  return server;
}

if (require.main === module) {
  const server = startHttpServer({ logger: console.log });
  if (!server) console.log('[http] server disabled. Set EXPRESS_SERVER_ENABLED=true to start it.');
}

module.exports = { startHttpServer };
