// ============ GAME STATE — single source of truth for read/push ============
// Kintara is client-authoritative: the client computes results and pushes state. This module
// wraps that required pattern correctly:
//   - always read a FRESH stateSeq from /me before pushing (baseSeq optimistic concurrency)
//   - preserve the full backpack structure (invSlots/hotbar/mountSlots/bankSlots/...)
//     to avoid wiping inventory, which is easy to do when sending partial payloads
//   - intentionalRemovals: [] for resource additions
//
// Important shape, confirmed from kintara.gg.har:
//   GET /api/auth/me          -> { ok, player, backpack(FLAT resources), stateSeq, ... }
//   POST /api/auth/save-backpack -> FULL body object with NESTED resources + baseSeq + removals
const { reportError } = require('./errorbus');

// 13 resource counters: top-level in /me.backpack, nested in save-backpack body.
const RESOURCE_KEYS = [
  'wood', 'stone', 'coal', 'metal', 'gold', 'fish', 'cooked_fish_meat',
  'raw_chicken', 'cooked_chicken', 'potion_health', 'potion_shield',
  'potion_strength', 'potion_poison',
];

// Mount-riding flags sent back in the save-backpack body; not present in /me.
const MOUNT_RIDING_FLAGS = [
  'mountDragonRiding', 'mountWhaleRiding', 'mountSpiderRiding', 'mountWolfRiding',
  'mountTigerRiding', 'mountUnicornRiding', 'mountCrocodileRiding', 'mountGiraffeRiding',
  'mountWoolyMammothRiding', 'mountHarambeRiding', 'mountTralaleroRiding',
];

// Slot arrays that must be preserved as-is.
const SLOT_ARRAYS = ['invSlots', 'hotbar', 'mountSlots', 'cosmeticSlots', 'petSlots', 'furnitureSlots', 'bankSlots'];

/**
 * Fetch complete state from /me.
 * @returns {Promise<{stateSeq:number, backpack:object, player:object, raw:object}>}
 */
async function fetchState(client) {
  const me = await client.me();
  if (!me?.ok) throw new Error('fetchState: /api/auth/me is not ok — session cookie may be invalid/expired.');
  return {
    stateSeq: me.stateSeq,
    backpack: me.backpack || {},
    player: me.player || {},
    raw: me,
  };
}

/**
 * Current skill XP; not present in /me, so fetch it from player-stats.
 * @returns {Promise<Record<string, number>>} e.g. { woodcutting, mining, fishing, ... }
 */
async function fetchSkills(client, playerId) {
  const res = await client.playerStats(playerId);
  return res?.skillXp || {};
}

/**
 * Build the COMPLETE POST /save-backpack body from the /me backpack object.
 * Transform flat resources -> nested `resources`; preserve every slot array;
 * mount*Riding defaults to false; not in /me, HAR shows false when not riding a mount.
 * @param {object} meBackpack   backpack from fetchState (flat resources)
 * @param {number} baseSeq      FRESH stateSeq from /me
 * @param {Array}  intentionalRemovals
 */
function buildBackpackBody(meBackpack, baseSeq, intentionalRemovals = []) {
  const resources = {};
  for (const k of RESOURCE_KEYS) resources[k] = Number(meBackpack[k] || 0);

  const body = { resources };
  for (const k of SLOT_ARRAYS) body[k] = meBackpack[k] ?? [];
  body.equippedHotbar = meBackpack.equippedHotbar ?? 0;
  for (const f of MOUNT_RIDING_FLAGS) body[f] = meBackpack[f] ?? false;
  body.baseSeq = baseSeq;
  body.intentionalRemovals = intentionalRemovals;
  return body;
}

/**
 * Push backpack to the server after resources have been mutated in `meBackpack`.
 * Always include a FRESH baseSeq. Throw on push failure so callers can back off.
 */
async function pushBackpack(client, meBackpack, baseSeq, intentionalRemovals = []) {
  const body = buildBackpackBody(meBackpack, baseSeq, intentionalRemovals);
  try {
    return await client.saveBackpack(body);
  } catch (e) {
    reportError({ code: 'PUSH_BACKPACK_FAIL', context: 'gameState.pushBackpack', message: e.message });
    throw e;
  }
}

/**
 * Push skill XP. Doc: POST /save-skills { skillXp }. baseSeq is included when required by the server.
 */
async function pushSkills(client, skillXp, baseSeq) {
  try {
    return await client.saveSkills(skillXp, baseSeq);
  } catch (e) {
    reportError({ code: 'PUSH_SKILLS_FAIL', context: 'gameState.pushSkills', message: e.message });
    throw e;
  }
}

module.exports = {
  RESOURCE_KEYS, MOUNT_RIDING_FLAGS, SLOT_ARRAYS,
  fetchState, fetchSkills, buildBackpackBody, pushBackpack, pushSkills,
};
