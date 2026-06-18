// ============ RECON STORE ============
// Read-only helpers for aggregating bot state from mounted recon directories.
const fs = require('fs');
const path = require('path');

const STATE_FILES = {
  fishing: 'bot-state.json',
  gather: 'gather-state.json',
  combat: 'combat-state.json',
  orchestrator: 'orchestrator-state.json',
  dailyQuest: 'daily-quest-state.json',
  tutorial: 'tutorial-watch-state.json',
};

const ACTIVITY_LABELS = {
  fishing: 'Fishing',
  gather: 'Gathering',
  combat: 'Combat',
  orchestrator: 'Auto',
  dailyQuest: 'Daily Quest',
  tutorial: 'Tutorial Watcher',
};

function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function readJsonFile(filePath) {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) return { data: null, mtimeMs: 0 };
  try {
    return { data: JSON.parse(fs.readFileSync(filePath, 'utf8')), mtimeMs: stat.mtimeMs };
  } catch (e) {
    return { data: null, mtimeMs: stat.mtimeMs, error: e.message };
  }
}

function readStates(reconPath) {
  return Object.fromEntries(
    Object.entries(STATE_FILES).map(([key, file]) => [key, readJsonFile(path.join(reconPath, file))]),
  );
}

function pickLatestState(states) {
  return Object.entries(states)
    .filter(([, value]) => value.data)
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)[0] || null;
}

function statusFromLastSeen(lastSeenMs) {
  if (!lastSeenMs) return 'unknown';
  const ageMs = Date.now() - lastSeenMs;
  if (ageMs < 5 * 60 * 1000) return 'active';
  if (ageMs < 30 * 60 * 1000) return 'stale';
  return 'offline';
}

function activityFromState(latest, states) {
  const orch = states.orchestrator.data;
  if (orch?.goal) {
    const goal = orch.goal === 'fish' ? 'Fishing' : orch.goal === 'gather' ? `Gathering (${orch.gatherKind || 'all'})` : orch.goal;
    return `Auto: ${goal}`;
  }
  if (!latest) return 'Unknown';
  const [key, value] = latest;
  if (key === 'gather' && value.data?.kind) return value.data.kind === 'rock' ? 'Mining' : 'Woodcutting';
  if (key === 'combat' && value.data?.phase) return `Combat (${value.data.phase})`;
  return ACTIVITY_LABELS[key] || key;
}

function buildInventory(states) {
  const snapshot = states.orchestrator.data?.snapshot || {};
  const fishing = states.fishing.data || {};
  const gather = states.gather.data || {};
  return {
    gold: snapshot.gold ?? null,
    fish: fishing.fish ?? snapshot.fish ?? null,
    cookedFish: fishing.cooked ?? snapshot.cooked_fish_meat ?? null,
    wood: gather.wood ?? snapshot.wood ?? null,
    stone: gather.stone ?? snapshot.stone ?? null,
    coal: gather.coal ?? snapshot.coal ?? null,
    metal: gather.metal ?? snapshot.metal ?? null,
  };
}

function buildLevels(states) {
  const snapshot = states.orchestrator.data?.snapshot || {};
  return {
    avg: snapshot.avg ?? null,
    fishing: snapshot.fishing ?? null,
    woodcutting: snapshot.woodcutting ?? null,
    mining: snapshot.mining ?? null,
    combat: states.combat.data?.combatNow ?? null,
  };
}

function listLogFiles(reconPath) {
  try {
    return fs.readdirSync(reconPath)
      .filter((file) => file.endsWith('.log'))
      .map((file) => {
        const stat = safeStat(path.join(reconPath, file));
        return { file, size: stat?.size || 0, mtimeMs: stat?.mtimeMs || 0 };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function tailFile(filePath, { lines = 200, maxBytes = 128 * 1024 } = {}) {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) return '';
  const size = stat.size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function extractPlayerName(reconPath) {
  const logText = tailFile(path.join(reconPath, 'bot.log'), { lines: 80, maxBytes: 32 * 1024 });
  const prefixed = logText.match(/^\[[^\]]+\]\s+\[([^\]]+)\]/m);
  if (prefixed?.[1]) return prefixed[1];
  return '';
}

function readBotSummary(source) {
  if (source.error) return { ...source, status: 'config-error', error: source.error };
  const reconStat = safeStat(source.reconPath);
  if (!reconStat?.isDirectory()) {
    return { ...source, status: 'missing', error: 'Recon path is not mounted or is not a directory' };
  }

  const states = readStates(source.reconPath);
  const latest = pickLatestState(states);
  const latestMtime = latest?.[1]?.mtimeMs || 0;
  const logs = listLogFiles(source.reconPath);
  const latestLogMtime = logs[0]?.mtimeMs || 0;
  const lastSeenMs = Math.max(latestMtime, latestLogMtime);

  return {
    id: source.id,
    name: source.name,
    reconPath: source.reconPath,
    status: statusFromLastSeen(lastSeenMs),
    lastSeenMs,
    activity: activityFromState(latest, states),
    playerName: states.fishing.data?.playerName || states.combat.data?.playerName || extractPlayerName(source.reconPath) || 'Unknown player',
    levels: buildLevels(states),
    inventory: buildInventory(states),
    state: Object.fromEntries(Object.entries(states).map(([key, value]) => [key, value.data])),
    logs,
  };
}

function resolveLogPath(source, file) {
  const logs = listLogFiles(source.reconPath).map((entry) => entry.file);
  const safeName = path.basename(String(file || ''));
  if (!logs.includes(safeName)) return null;
  return path.join(source.reconPath, safeName);
}

module.exports = { readBotSummary, listLogFiles, resolveLogPath, tailFile };
