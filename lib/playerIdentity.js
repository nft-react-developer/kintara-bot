// ============ PLAYER IDENTITY HELPERS ============
// Kintara responses are not treated as a strict contract here: depending on the
// endpoint/version, the player name can be exposed under different fields.

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickPlayerName(...sources) {
  for (const source of sources.filter(Boolean)) {
    const name = firstText(
      source.displayName,
      source.username,
      source.name,
      source.handle,
      source.playerName,
      source.profile?.displayName,
      source.profile?.username,
      source.profile?.name,
      source.user?.displayName,
      source.user?.username,
      source.user?.name,
      source.player?.displayName,
      source.player?.username,
      source.player?.name,
      source.player?.handle,
      source.player?.playerName,
    );
    if (name) return name;
  }
  return '';
}

function pickPlayerId(...sources) {
  for (const source of sources.filter(Boolean)) {
    const id = source.id || source.playerId || source.player?.id || source.user?.id || source.profile?.id;
    if (id) return String(id);
  }
  return '';
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function playerLabel({ name, id } = {}) {
  const safeName = htmlEscape(name);
  if (safeName) return safeName;
  const shortId = id ? String(id).slice(0, 8) : '';
  return shortId ? `Player ${htmlEscape(shortId)}` : 'Unknown player';
}

module.exports = { pickPlayerName, pickPlayerId, playerLabel, htmlEscape };
