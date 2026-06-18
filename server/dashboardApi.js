// ============ DASHBOARD API ROUTES ============
const express = require('express');
const { getDashboardSources } = require('./dashboardSources');
const { readBotSummary, resolveLogPath, tailFile } = require('./reconStore');

function createDashboardApi() {
  const router = express.Router();

  router.get('/bots', (_req, res) => {
    const sources = getDashboardSources();
    res.json({ bots: sources.map(readBotSummary) });
  });

  router.get('/bots/:id/status', (req, res) => {
    const source = getDashboardSources().find((item) => item.id === req.params.id);
    if (!source) return res.status(404).json({ error: 'bot_not_found' });
    return res.json(readBotSummary(source));
  });

  router.get('/bots/:id/logs', (req, res) => {
    const source = getDashboardSources().find((item) => item.id === req.params.id);
    if (!source) return res.status(404).json({ error: 'bot_not_found' });
    return res.json({ logs: readBotSummary(source).logs || [] });
  });

  router.get('/bots/:id/logs/:file', (req, res) => {
    const source = getDashboardSources().find((item) => item.id === req.params.id);
    if (!source) return res.status(404).json({ error: 'bot_not_found' });
    const filePath = resolveLogPath(source, req.params.file);
    if (!filePath) return res.status(404).json({ error: 'log_not_found' });
    const lines = Math.min(Math.max(parseInt(req.query.lines || '200', 10) || 200, 1), 1000);
    res.type('text/plain').send(tailFile(filePath, { lines }));
  });

  router.get('/summary', (_req, res) => {
    const bots = getDashboardSources().map(readBotSummary);
    res.json({
      total: bots.length,
      active: bots.filter((bot) => bot.status === 'active').length,
      stale: bots.filter((bot) => bot.status === 'stale').length,
      offline: bots.filter((bot) => bot.status === 'offline').length,
      missing: bots.filter((bot) => bot.status === 'missing').length,
      bots,
    });
  });

  return router;
}

module.exports = { createDashboardApi };
