// ============ GAME STATE — single source of truth untuk read/push ============
// Kintara client-authoritative: client hitung hasil lalu PUSH state. Modul ini
// membungkus pola WAJIB tsb dengan benar:
//   - selalu baca stateSeq FRESH dari /me sebelum push (baseSeq optimistic-concurrency)
//   - PRESERVE seluruh struktur backpack (invSlots/hotbar/mountSlots/bankSlots/...)
//     supaya tidak meng-wipe inventory (bug yang mudah terjadi kalau kirim partial)
//   - intentionalRemovals: [] untuk penambahan resource
//
// Shape penting (dikonfirmasi dari HAR kintara.gg.har):
//   GET /api/auth/me          -> { ok, player, backpack(FLAT resources), stateSeq, ... }
//   POST /api/auth/save-backpack -> body objek LENGKAP dgn resources NESTED + baseSeq + removals
const { reportError } = require('./errorbus');

// 13 resource counter (top-level di /me.backpack, nested di body save-backpack).
const RESOURCE_KEYS = [
  'wood', 'stone', 'coal', 'metal', 'gold', 'fish', 'cooked_fish_meat',
  'raw_chicken', 'cooked_chicken', 'potion_health', 'potion_shield',
  'potion_strength', 'potion_poison',
];

// Flag mount-riding yang dikirim balik di body save-backpack (tidak ada di /me).
const MOUNT_RIDING_FLAGS = [
  'mountDragonRiding', 'mountWhaleRiding', 'mountSpiderRiding', 'mountWolfRiding',
  'mountTigerRiding', 'mountUnicornRiding', 'mountCrocodileRiding', 'mountGiraffeRiding',
  'mountWoolyMammothRiding', 'mountHarambeRiding', 'mountTralaleroRiding',
];

// Array slot yang harus di-preserve apa adanya.
const SLOT_ARRAYS = ['invSlots', 'hotbar', 'mountSlots', 'cosmeticSlots', 'petSlots', 'furnitureSlots', 'bankSlots'];

/**
 * Ambil state lengkap dari /me.
 * @returns {Promise<{stateSeq:number, backpack:object, player:object, raw:object}>}
 */
async function fetchState(client) {
  const me = await client.me();
  if (!me?.ok) throw new Error('fetchState: /api/auth/me tidak ok — cookie session mungkin invalid/expired.');
  return {
    stateSeq: me.stateSeq,
    backpack: me.backpack || {},
    player: me.player || {},
    raw: me,
  };
}

/**
 * Skill XP terkini (tidak ada di /me — ambil dari player-stats).
 * @returns {Promise<Record<string, number>>}  mis. { woodcutting, mining, fishing, ... }
 */
async function fetchSkills(client, playerId) {
  const res = await client.playerStats(playerId);
  return res?.skillXp || {};
}

/**
 * Bangun body POST /save-backpack LENGKAP dari objek backpack /me.
 * Transform: resource flat -> nested `resources`; preserve seluruh slot array;
 * mount*Riding default false (tidak ada di /me; HAR menunjukkan false saat tidak naik mount).
 * @param {object} meBackpack   backpack dari fetchState (flat resources)
 * @param {number} baseSeq      stateSeq FRESH dari /me
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
 * Push backpack (resource sudah dimutate di `meBackpack`) ke server.
 * Selalu sertakan baseSeq FRESH. Lempar error kalau push gagal supaya caller bisa backoff.
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
 * Push skill XP. Doc: POST /save-skills { skillXp }. baseSeq disertakan jika server memintanya.
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
