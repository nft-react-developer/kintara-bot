// ============ DASHBOARD SOURCE CONFIG ============
// Loads read-only recon sources from server/dashboard-bots.json.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'dashboard-bots.json');

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

function readDashboardConfig(configPath = CONFIG_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('dashboard-bots.json must contain an array');
    return { sources: parsed, error: null };
  } catch (e) {
    return { sources: [], error: e.message };
  }
}

function getDashboardSources(configPath = CONFIG_PATH) {
  const { sources, error } = readDashboardConfig(configPath);
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

module.exports = { getDashboardSources, CONFIG_PATH };
