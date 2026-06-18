// ============ DASHBOARD SOURCE CONFIG ============
// Loads read-only recon sources from EXPRESS_DASHBOARD_BOT.
const path = require('path');
const { config } = require('../config');

const ROOT = path.join(__dirname, '..');

function normalizeSource(source, index) {
  const id = String(source.id || `bot${index + 1}`).trim();
  const name = String(source.name || id).trim();
  const reconPath = String(source.reconPath || source.path || '').trim();
  if (!id || !reconPath) return null;
  return {
    id: id.replace(/[^a-zA-Z0-9_-]/g, '-'),
    name,
    reconPath: path.isAbsolute(reconPath) ? reconPath : path.resolve(ROOT, reconPath),
  };
}

function readDashboardConfig(raw = config.expressDashboardBot) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) throw new Error('EXPRESS_DASHBOARD_BOT must contain a JSON array');
    return { sources: parsed, error: null };
  } catch (e) {
    return { sources: [], error: e.message };
  }
}

function getDashboardSources(raw = config.expressDashboardBot) {
  const { sources, error } = readDashboardConfig(raw);
  if (error) return [{ id: 'config-error', name: 'Config error', reconPath: '', error }];

  const seen = new Set();
  return sources
    .map(normalizeSource)
    .filter(Boolean)
    .filter((source) => {
      if (seen.has(source.id)) return false;
      seen.add(source.id);
      return true;
    });
}

module.exports = { getDashboardSources };
