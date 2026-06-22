#!/usr/bin/env node
// ============ COMBAT BOT — Wilderness hunting (Path A, headless) ============
// Server-authoritative mobs: hub broadcasts position+HP in snap.npcs.wildMobs.
// Flow: login -> BANK all loot (safety) -> queue+presence -> enter wild
// (north portal) -> hunt nearest zombie (walk adjacent -> wm_ev hit until dead).
// Combat XP is granted by the server (skill_xp push); daily zombie quest progresses via wm_ev by=me.
//
// STRICT SURVIVAL:
//  - BANK-FIRST is mandatory (zero carried-loss risk if death happens).
//  - Monitor HP (wild_mb_ack/pvit/snap). HP<=POTION_HP -> consumePotion health.
//    HP<=SHIELD_HP -> + potion_shield. HP<=RETREAT_HP / no potions left -> RETREAT
//    to safe camp + exit Mainland. Bot NEVER sends wmb contact reports -> mob
//    cannot damage us; the real risk is PvP. Retreat remains a safety net.
//
// Usage: node tools/combat-bot.js [shard=s2]
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { Presence } = require('../lib/presenceWs');
const { KintaraClient } = require('../lib/kintaraClient');
const { isWalletBannedError } = require('../lib/walletAuth');
const bank = require('../lib/bank');
const { pickInventorySnapshot } = require('../lib/inventorySnapshot');
const { POTION_RECIPES: POTION_COSTS } = require('../lib/potionCommand');

const SHARD = process.argv[2] || config.shard || 's4';
const OUT = path.join(__dirname, '..', 'recon');
const PIDFILE = path.join(OUT, 'control', 'combatbot.pid');
const STATEFILE = path.join(OUT, 'combat-state.json');
const LOGFILE = path.join(OUT, 'combat.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryDelayMs = (attempt, base = 5000, cap = 60000) => Math.min(cap, base * (2 ** Math.max(0, attempt - 1))) + Math.floor(Math.random() * 1500);
const TRANSIENT_FAILOVER_AFTER = 5;
const isTransientGatewayErr = (msg) => /503|Unexpected token '<'|<!doctype|Non-JSON|presence ws err/i.test(String(msg || ''));
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); try { fs.appendFileSync(LOGFILE, s + '\n'); } catch {} };
const lt = {}; const logT = (k, m, ms = 30000) => { const n = Date.now(); if (!lt[k] || n - lt[k] > ms) { lt[k] = n; log(m); } };

// ---- coords ----
const MAIN_OFF = -30.5;                       // mainland world x=col-30.5
const NORTH_PORTAL = { x: 30 - 30.5, z: 0 - 30.5 }; // col30,row0 = (-0.5,-30.5)
const WILD_OFF = -24.5;                        // wild world x=col-24.5
const SAFE_CAMP = { col: 25, row: 47 };        // rows 45-49 = no mob spawn
const wildWorld = (col, row) => ({ x: col + WILD_OFF, z: row + WILD_OFF });

// ---- combat constants (from recon/re/constants.js) ----
const SWING_COOLDOWN_MS = 1500;   // WILD_SWORD_SWING_COOLDOWN_S
const ZOMBIE_LIVES = 5;
const HIT_MULT = 1;               // L1 wild_sword (no strength)

// ---- survival thresholds ----
const POTION_HP = 45;   // drink health potion at/below
const SHIELD_HP = 28;   // also pop shield
const RETREAT_HP = 22;  // bail to safe camp + Mainland
const MIN_GOLD = Math.max(0, Number(config.combatMinGold) || 20);
const TARGET_HEALTH_POTIONS = Math.max(0, Number(config.combatMinHealthPotions) || 6);
const TARGET_SHIELD_POTIONS = Math.max(0, Number(config.combatMinShieldPotions) || 2);

const stats = {
  kills: 0, hits: 0, combatStart: null, combatNow: null, combatGain: 0,
  potionsHealth: 0, potionsShield: 0, retreats: 0, deaths: 0, reconnects: 0,
  hp: 100, region: 'world', phase: 'boot', queueAhead: null, started: Date.now(),
  skillXp: {}, lootScans: 0, lootClaims: 0, lootErrors: 0,
};

const WS_LOOT_HINT_RE = /loot|drop|bag|reward|grant|backpack|invSlots|hotbar|mountSlots|cosmeticSlots|petSlots|furnitureSlots|gold|wild_sword|tool_/i;

function hasWsLootHint(value, depth = 0) {
  if (value == null || depth > 5) return false;
  if (typeof value === 'string') return WS_LOOT_HINT_RE.test(value);
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.slice(0, 30).some((item) => hasWsLootHint(item, depth + 1));
  return Object.entries(value).some(([key, item]) => WS_LOOT_HINT_RE.test(key) || hasWsLootHint(item, depth + 1));
}

function compactJson(value, max = 2200) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function logCombatWsDiagnostic(p, message) {
  if (!message || typeof message !== 'object') return;
  const ownCombatEvent = message.t === 'wm_ev' && Number(message.by) === Number(p.myId);
  const killEvent = ownCombatEvent && (Number(message.zm) === 1 || Number(message.dr) === 1);
  if (killEvent) {
    log(`📡 ws kill payload: ${compactJson(message)}`);
    return;
  }
  if (hasWsLootHint(message)) {
    logT(`wshint:${message.t || 'unknown'}`, `📡 ws loot hint ${message.t || 'unknown'}: ${compactJson(message)}`, 3000);
  }
}

function saveState(extra = {}) {
  try { fs.writeFileSync(STATEFILE, JSON.stringify({ ...stats, ...extra, ageMin: Math.round((Date.now() - stats.started) / 60000) }, null, 2)); } catch {}
}
function trackAccountMeta(me) {
  if (!me || (!me.ok && !me.player && !me.backpack && !me.meta)) return;
  stats.dailySpinnerLastMs = me?.meta?.dailySpinnerLastMs ?? null;
  if (me?.backpack) stats.inventory = pickInventorySnapshot(me.backpack);
}

let cli, currentPlayer;
async function createClientWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await KintaraClient.create();
    } catch (e) {
      if (isWalletBannedError(e)) throw e;
      const waitMs = retryDelayMs(attempt);
      stats.phase = 'bootstrap_retry';
      stats.queueAhead = null;
      saveState();
      log(`bootstrap attempt ${attempt} failed: ${String(e.message || e).slice(0, 60)} — retry ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}
let healthLeft = 0, shieldLeft = 0;   // filled from the backpack at startup (server authoritative)
let lastPotionAt = 0;
let mats = { gold: 0, wood: 0, stone: 0, coal: 0, metal: 0 };
const bankCount = (bp, type) => {
  const arr = Array.isArray(bp?.bankSlots) ? bp.bankSlots : [];
  const slot = arr.find((s) => s && s.t === type);
  return slot ? Number(slot.n) || 0 : 0;
};

// Health potion = HoT +20/tick x5 = +100 total, CLIENT-DRIVEN (consume-potion only
// reduces potion count; real healing is client-side + save-hp). Headless applies and persists it.
const HEALTH_POTION_TOTAL = 100;

async function refreshPotionCounts() {
  try {
    const me = await cli.me(); const bp = me.backpack || {};
    trackAccountMeta(me);
    healthLeft = Number(bp.potion_health) || 0;
    shieldLeft = Number(bp.potion_shield) || 0;
    mats = {
      gold: Number(bp.gold) || 0,
      wood: (Number(bp.wood) || 0) + bankCount(bp, 'wood'),
      stone: (Number(bp.stone) || 0) + bankCount(bp, 'stone'),
      coal: (Number(bp.coal) || 0) + bankCount(bp, 'coal'),
      metal: Number(bp.metal) || 0,
    };
    saveState();
    return { ...mats, healthLeft, shieldLeft };
  } catch {}
  return { ...mats, healthLeft, shieldLeft };
}

async function ensureCombatSupplies() {
  await refreshPotionCounts();
  log(`🧪 initial stock: health=${healthLeft}/${TARGET_HEALTH_POTIONS} shield=${shieldLeft}/${TARGET_SHIELD_POTIONS} | wood=${mats.wood} stone=${mats.stone} coal=${mats.coal} gold=${mats.gold}`);

  const canAfford = (type) => {
    const cost = POTION_COSTS[type] || {};
    return Object.entries(cost).every(([k, v]) => (Number(mats[k]) || 0) >= v);
  };

  const buyUntilTarget = async (type, target) => {
    while (canAfford(type)) {
      const current = type === 'potion_health' ? healthLeft : shieldLeft;
      if (current >= target) break;
      const r = await cli.alchemistPotionBuy(type, 1).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok !== false && !r.error) {
        await refreshPotionCounts();
        log(`🧪 buy ${type} ok -> health=${healthLeft} shield=${shieldLeft} | wood=${mats.wood} stone=${mats.stone} coal=${mats.coal} gold=${mats.gold}`);
        saveState();
        continue;
      }
      logT(`buy-${type}`, `🧪 buy ${type} stop: ${r?.error || 'rejected'}`, 5000);
      break;
    }
  };

  await buyUntilTarget('potion_health', TARGET_HEALTH_POTIONS);
  await buyUntilTarget('potion_shield', TARGET_SHIELD_POTIONS);

  if (mats.gold <= MIN_GOLD) {
    log(`💰 reserve guard active — keeping at least ${MIN_GOLD}`);
  }
  saveState();
  log(`🧪 final stock: health=${healthLeft} shield=${shieldLeft} | wood=${mats.wood} stone=${mats.stone} coal=${mats.coal} gold=${mats.gold}`);
}

async function tryPotion(p, type) {
  const now = Date.now();
  if (now - lastPotionAt < 2500) return false; // rate-limit guard
  if (type === 'potion_health' && healthLeft <= 0) return false;
  if (type === 'potion_shield' && shieldLeft <= 0) return false;
  lastPotionAt = now;
  try {
    const r = await cli.consumePotion(type);
    if (r && r.ok !== false && !r.error) {
      if (type === 'potion_health') {
        stats.potionsHealth++; healthLeft = Math.max(0, healthLeft - 1);
        // drive HoT + persist: server trusts save-hp during combat (combatHealRealtime)
        p.hp = Math.min(100, (p.hp | 0) + HEALTH_POTION_TOTAL);
        try { await cli.saveHp(p.hp); } catch {}
      } else if (type === 'potion_shield') {
        stats.potionsShield++; shieldLeft = Math.max(0, shieldLeft - 1); p.shield = 5;
      }
      saveState();
      log(`🧪 drank ${type} -> hp=${p.hp} (health left=${healthLeft})`);
      return true;
    }
    logT('potfail', `potion ${type} rejected: ${r?.error || 'unknown'}`);
  } catch (e) { logT('poterr', `potion err: ${e.message.slice(0, 40)}`); }
  return false;
}

// HP-driven survival reaction. Returns 'retreat' if the bot must bail, 'dead' if death happens.
async function survivalCheck(p) {
  const hp = p.hp | 0;
  stats.hp = hp;
  if (hp <= 0) {
    stats.deaths++;
    stats.phase = 'dead';
    saveState();
    log('💀 HP 0 — died (loot already banked = safe)');
    return 'dead';
  }
  // critical: bail to safe camp
  if (hp <= RETREAT_HP) {
    if (healthLeft <= 0 && shieldLeft <= 0) { log(`🩸 HP ${hp} critical and out of potions — RETREAT+EXIT`); return 'retreat'; }
    log(`🩸 HP ${hp} <= ${RETREAT_HP} — RETREAT (heal at safe camp)`); return 'retreat';
  }
  // low: pop shield first when available, then heal
  if (hp <= SHIELD_HP && shieldLeft > 0 && (p.shield | 0) <= 0) await tryPotion(p, 'potion_shield');
  if (hp <= POTION_HP && healthLeft > 0) await tryPotion(p, 'potion_health');
  return 'ok';
}

async function enterWild(p) {
  log('walking to Mainland north portal...');
  p.equip('wild_sword');
  await p.walkTo(NORTH_PORTAL.x, NORTH_PORTAL.z, { until: () => /^wild/.test(p.region), maxSec: 40 });
  await sleep(1500);
  if (!/^wild/.test(p.region)) {
    log('forcing setRegion wild (portal tile handoff)');
    const sp = wildWorld(25, 48); // WILD_SPAWN
    p.setRegion('wild', sp.x, sp.z);
    await sleep(3000);
  }
  if (!/^wild/.test(p.region)) return false;
  // send blocked-tile manifest, which the hub needs for mob spawn/pathing. Empty is enough to trigger spawn.
  p.sendWildManifest([]);
  stats.region = p.region;
  stats.phase = 'wild';
  stats.queueAhead = null;
  log(`✅ entered wild region=${p.region} tile=${JSON.stringify(p.wildTile())}`);
  // baseline combat XP (playerStats.skillXp.combat — not me())
  try {
    const st = await cli.playerStats(p.myId);
    if (st?.skillXp) stats.skillXp = { ...stats.skillXp, ...st.skillXp };
    stats.combatStart = st?.skillXp?.combat ?? 0;
    stats.combatNow = stats.combatStart;
    log(`baseline combat XP=${stats.combatStart}`);
  } catch {}
  await refreshPotionCounts();
  saveState();
  log(`🧪 potions: health=${healthLeft} shield=${shieldLeft}`);
  return true;
}

async function retreatToSafe(p) {
  stats.retreats++;
  stats.phase = 'retreat';
  saveState();
  const sc = wildWorld(SAFE_CAMP.col, SAFE_CAMP.row);
  log(`🏃 retreating to safe camp (hp=${p.hp})...`);
  await p.walkTo(sc.x, sc.z, { maxSec: 30 });
  await sleep(1500);
  // heal with health potions until HP is safe (>=80) or potions run out.
  // tryPotion now drives +100 healing + save-hp, so 1 potion is usually enough.
  for (let i = 0; i < 8 && p.hp < 80 && healthLeft > 0; i++) {
    await tryPotion(p, 'potion_health');
    await sleep(2600); // respect potion rate limit
  }
  if (healthLeft <= 0 && p.hp <= RETREAT_HP) {
    log('🚪 out of potions and low HP — EXIT to Mainland (combat session safely finished)');
    p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1);
    stats.region = 'world';
    stats.phase = 'exit';
    saveState();
    await sleep(3000);
    return 'exited';
  }
  log(`🛡️ recovered hp=${p.hp} (health left=${healthLeft}), continuing hunt`);
  stats.phase = 'hunt';
  saveState();
  return 'recovered';
}

function shardNumber(shard = SHARD) {
  const m = String(shard || '').match(/\d+/);
  return m ? Number(m[0]) : shard;
}

function asArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['bags', 'groundBags', 'items', 'loot', 'data']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function bagIdOf(bag) {
  return bag?.bagId ?? bag?.id ?? bag?._id ?? bag?.uuid ?? null;
}

function bagOwnerOf(bag) {
  return bag?.ownerId ?? bag?.owner ?? bag?.playerId ?? bag?.victimId ?? bag?.pid ?? bag?.by ?? null;
}

function bagWorldPos(bag) {
  const x = Number(bag?.x ?? bag?.px);
  const z = Number(bag?.z ?? bag?.pz);
  if (Number.isFinite(x) && Number.isFinite(z)) return { x, z };
  const col = Number(bag?.col ?? bag?.c);
  const row = Number(bag?.row ?? bag?.r);
  if (Number.isFinite(col) && Number.isFinite(row)) return wildWorld(col, row);
  return null;
}

function bagDistance(p, bag) {
  const pos = bagWorldPos(bag);
  if (!pos) return null;
  return Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z);
}

function currentWildTile(p) {
  if (typeof p.wildTile === 'function') return p.wildTile();
  return {
    col: Math.round(p.pos.x - WILD_OFF),
    row: Math.round(p.pos.z - WILD_OFF),
  };
}

function lootBagPayload(p, bag) {
  const tile = currentWildTile(p);
  const region = String(p.region || 'wild');
  return {
    bagId: String(bagIdOf(bag)),
    shard: shardNumber(p.shard),
    col: tile.col | 0,
    row: tile.row | 0,
    realm: region === 'wild_exp' ? 'wild_exp' : region === 'wild_ext' ? 'wild_ext' : 'wild',
    takeAll: true,
  };
}

function lootErrorOf(result) {
  return result?.error || result?.body?.error || result?.message || 'unknown';
}

function lootStatusOf(result) {
  return result?.status || result?.body?.status || 'n/a';
}

function itemSummary(items) {
  if (!Array.isArray(items) || !items.length) return 'empty';
  return items
    .slice(0, 8)
    .map((item) => `${item?.t || item?.type || '?'}x${Number(item?.n ?? item?.qty ?? 1) || 1}`)
    .join(', ');
}

function bagSummary(p, bag) {
  const pos = bagWorldPos(bag);
  const dist = bagDistance(p, bag);
  return [
    `id=${bagIdOf(bag) ?? '?'}`,
    `owner=${bagOwnerOf(bag) ?? '?'}`,
    `region=${bag?.region ?? '?'}`,
    `shard=${bag?.shardId ?? '?'}`,
    `col=${bag?.col ?? '?'}`,
    `row=${bag?.row ?? '?'}`,
    pos ? `pos=${pos.x.toFixed(1)},${pos.z.toFixed(1)}` : 'pos=?',
    dist == null ? 'dist=?' : `dist=${dist.toFixed(2)}`,
    `items=${itemSummary(bag?.items)}`,
  ].join(' ');
}

function lootSkipReason(p, bag) {
  const id = bagIdOf(bag);
  if (id == null) return 'missing_id';
  if (bag?.region && !/^wild/.test(String(bag.region))) return 'wrong_region';
  if (bag?.shardId != null && Number(bag.shardId) !== Number(shardNumber(p.shard))) return 'wrong_shard';
  const owner = bagOwnerOf(bag);
  if (owner != null && p.myId != null && Number(owner) !== Number(p.myId)) return 'wrong_owner';
  const dist = bagDistance(p, bag);
  if (dist != null && dist > 8) return 'too_far';
  return null;
}

function isLootCandidate(p, bag) {
  return lootSkipReason(p, bag) == null;
}

async function collectNearbyLoot(p, reason = 'scan') {
  if (!/^wild/.test(p.region)) return 0;
  stats.lootScans++;
  try {
    const res = await cli.groundBags(shardNumber(p.shard));
    const allBags = asArrayPayload(res);
    const bags = [];
    const skipped = {};
    for (const bag of allBags) {
      const skipReason = lootSkipReason(p, bag);
      if (skipReason) {
        skipped[skipReason] = (skipped[skipReason] || 0) + 1;
      } else {
        bags.push(bag);
      }
    }
    const tile = currentWildTile(p);
    const skipText = Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    log(`🎒 loot scan ${reason}: raw=${allBags.length} candidates=${bags.length} skipped=${skipText} me=${p.myId ?? '?'} shard=${shardNumber(p.shard)} region=${p.region} tile=${tile.col},${tile.row} pos=${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)} hp=${p.hp}`);
    let claimed = 0;
    bags.sort((a, b) => (bagDistance(p, a) ?? 999) - (bagDistance(p, b) ?? 999));
    for (const bag of bags.slice(0, 5)) {
      if (p.hp <= RETREAT_HP) break;
      const id = bagIdOf(bag);
      const pos = bagWorldPos(bag);
      const dist = bagDistance(p, bag);
      log(`🎒 loot candidate: ${bagSummary(p, bag)}`);
      if (pos && dist != null && dist > 1.5) {
        log(`🎒 walking to bag ${id}: from=${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)} to=${pos.x.toFixed(1)},${pos.z.toFixed(1)} dist=${dist.toFixed(2)}`);
        await p.walkTo(pos.x, pos.z, { maxSec: 6, until: () => p.hp <= RETREAT_HP });
        await sleep(250);
        if (p.hp <= RETREAT_HP) break;
      }
      const payload = lootBagPayload(p, bag);
      log(`🎒 loot request ${id}: ${JSON.stringify(payload)}`);
      const r = await cli.lootBag(payload).catch((e) => ({ ok: false, status: e.status, error: e.message, body: e.body }));
      if (r && r.ok !== false && !r.error) {
        claimed++;
        stats.lootClaims++;
        if (r.backpack) stats.inventory = pickInventorySnapshot(r.backpack);
        log(`🎒 loot success ${id}: partial=${Boolean(r.partial)} removed=${r.bag == null} backpack=${Boolean(r.backpack)} remaining=${itemSummary(r?.bag?.items)}`);
        await sleep(350);
      } else {
        stats.lootErrors++;
        log(`🎒 loot rejected ${id}: status=${lootStatusOf(r)} error=${String(lootErrorOf(r)).slice(0, 120)} body=${JSON.stringify(r?.body || {}).slice(0, 240)}`);
      }
    }
    if (claimed) saveState();
    return claimed;
  } catch (e) {
    stats.lootErrors++;
    logT('looterr', `loot scan err: ${String(e.message || e).slice(0, 60)}`, 15000);
    saveState();
    return 0;
  }
}

async function huntLoop(p) {
  // wait for the hub to spawn mobs (wildMobs in snap)
  log('waiting for wildMobs from hub...');
  for (let w = 0; w < 15 && !p.wildMobs.some((m) => m.alive); w++) {
    await sleep(2000);
    if (w % 3 === 0) logT('waitmob', `  waiting for mobs... ${w * 2}s (mobs=${p.wildMobs.length})`);
    if (w === 5) { p.sendWildManifest([]); } // re-send manifest
  }
  const aliveCount = p.wildMobs.filter((m) => m.alive).length;
  if (!aliveCount) { log('⚠️ hub did not send mobs after 30s — trying reconnect'); return; }
  stats.phase = 'hunt';
  saveState();
  log(`🧟 ${aliveCount} live mobs detected. Starting hunt.`);

  let nextLootScanAt = 0;
  while (p.ready && /^wild/.test(p.region)) {
    const sv = await survivalCheck(p);
    if (sv === 'dead') return 'dead';
    if (sv === 'retreat') { const r = await retreatToSafe(p); if (r === 'exited') return 'exited'; continue; }
    if (Date.now() >= nextLootScanAt) {
      await collectNearbyLoot(p, 'periodic');
      nextLootScanAt = Date.now() + 10000;
    }

    const target = p.nearestMob();
    if (!target) { logT('nomob', 'no live mobs, waiting for respawn...'); await sleep(3000); continue; }

    // walk adjacent (cheb<=1). Target tile -> stand 1 tile south of it (row-1 toward spawn).
    if (target.cheb > 1) {
      const dest = wildWorld(target.col, target.row + 1); // approach from the south (safe direction)
      await p.walkTo(dest.x, dest.z, { maxSec: 18, until: () => p.hp <= RETREAT_HP });
      await sleep(400);
      if (p.hp <= RETREAT_HP) continue;
    }

    // re-resolve mob index because snap can update
    const tt = p.wildMobs[target.i];
    if (!tt || !tt.alive) { await sleep(300); continue; }
    const cheb = Math.max(Math.abs(tt.col - p.wildTile().col), Math.abs(tt.row - p.wildTile().row));
    if (cheb > 1) { logT('chase', `mob moved (cheb=${cheb}), chasing...`); continue; }

    // HIT: swing loop until the mob dies (lv=0) or moves away
    p.equip('wild_sword');
    const startKills = stats.kills;
    for (let swing = 0; swing < ZOMBIE_LIVES + 3; swing++) {
      const m = p.wildMobs[target.i];
      if (!m || !m.alive) break;
      const c = Math.max(Math.abs(m.col - p.wildTile().col), Math.abs(m.row - p.wildTile().row));
      if (c > 1) break; // mob moved away, re-target
      const ok = p.sendWildMobHit(target.i, HIT_MULT);
      if (ok) { stats.hits++; saveState(); logT('swing', `🗡️ hit mob[${target.i}] lv=${m.lv}`, 8000); }
      await sleep(SWING_COOLDOWN_MS);
      if (await survivalCheck(p) === 'retreat') break;
    }
    // check whether it died (lv becomes 0 / alive false after snap)
    await sleep(600);
    const after = p.wildMobs[target.i];
    if (after && !after.alive && stats.kills === startKills) { /* kill is handled by wm_kill event */ }
    if (stats.kills > startKills || (after && !after.alive)) await collectNearbyLoot(p, 'post-kill');
    saveState();
    await sleep(400);
  }
}

async function connectWithRetry() {
  let transientGatewayFails = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const p = new Presence(SHARD);
      if (cli) p.setCookie(cli.cookie, currentPlayer);
      p.on('log', (m) => log('[ws] ' + m));
      p.on('msg', (d) => logCombatWsDiagnostic(p, d));
      p.on('queue', (d) => {
        stats.phase = (stats.hp | 0) <= 0 && stats.deaths > 0 ? 'requeue_after_death' : 'queue';
        stats.queueAhead = Number.isFinite(Number(d?.ahead)) ? Number(d.ahead) : null;
        saveState();
        if (d.ahead % 5 === 0) log('queue ahead=' + d.ahead);
      });
      // kill attribution + XP
      p.on('wm_kill', (d) => {
        if (Number(d.zm) === 1 || Number(d.dr) === 1) {
          stats.kills++;
          stats.phase = 'hunt';
          saveState();
          log(`☠️ KILL #${stats.kills} (${d.zm ? 'zombie' : 'dragon'}) mob[${d.i}]`);
        }
      });
      p.on('skill_xp', (xp) => {
        if (xp && xp.combat != null) {
          stats.skillXp = { ...stats.skillXp, ...xp };
          stats.combatNow = xp.combat;
          if (stats.combatStart != null) stats.combatGain = xp.combat - stats.combatStart;
          saveState();
          logT('xp', `📈 combat XP=${xp.combat} (+${stats.combatGain})`, 10000);
        }
      });
      p.on('hp', (hp) => { stats.hp = hp; saveState(); });
      await p.connect();
      transientGatewayFails = 0;
      stats.phase = 'presence';
      stats.region = p.region;
      stats.queueAhead = null;
      saveState();
      log('✅ presence live region=' + p.region);
      return p;
    } catch (e) {
      if (isWalletBannedError(e)) throw e;
      if (isTransientGatewayErr(e.message)) transientGatewayFails++;
      else transientGatewayFails = 0;
      if (transientGatewayFails >= TRANSIENT_FAILOVER_AFTER) {
        stats.phase = 'failover_restart';
        stats.queueAhead = null;
        saveState();
        log(`♻️ shard failover after ${transientGatewayFails} transient gateway errors`);
        throw new Error('transient_presence_failover');
      }
      const waitMs = retryDelayMs(attempt);
      stats.phase = 'reconnect_wait';
      stats.queueAhead = null;
      saveState();
      log(`connect attempt ${attempt} failed: ${e.message.slice(0, 60)} — retry ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  try { fs.writeFileSync(LOGFILE, ''); } catch {}
  try { fs.mkdirSync(path.dirname(PIDFILE), { recursive: true }); fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, started: Date.now() })); } catch {}
  process.on('exit', () => { try { fs.unlinkSync(PIDFILE); } catch {} });
  const { client: c, player } = await createClientWithRetry();
  cli = c;
  currentPlayer = player;
  saveState();
  log('COMBAT BOT START pid=' + player?.id + ' shard=' + SHARD);

  for (;;) {
    const p = await connectWithRetry();
    let expectedClose = false;
    p.on('close', () => {
      if (expectedClose) return;
      stats.reconnects++;
      stats.phase = 'reconnect';
      saveState();
      log('⚠️ presence closed -> reconnect');
    });
    p.hp = 100; p.shield = 0;
    stats.phase = 'prep';
    stats.region = p.region;
    stats.hp = 100;
    stats.queueAhead = null;
    saveState();
    await sleep(2000);

    // === BANK-FIRST (safety) — before entering wild ===
    try {
      log('🏦 banking first (safety)...');
      await p.walkTo(bank.BANK_WORLD.x, bank.BANK_WORLD.z, { maxSec: 30 });
      await sleep(1500);
      const r = await bank.depositAll(cli);
      log(r.moved.length ? `🏦 banked: ${r.moved.join(', ')}` : '🏦 no loot to bank (safe)');
    } catch (e) { log('bank err (continuing): ' + e.message.slice(0, 50)); }

    try {
      await ensureCombatSupplies();
    } catch (e) {
      log('alchemist err (continuing): ' + e.message.slice(0, 50));
    }

    // === ENTER WILD ===
    const entered = await enterWild(p);
    if (!entered) { log('🛑 failed to enter wild — reconnect'); try { p.close(); } catch {} await sleep(5000); continue; }

    // === HUNT ===
    let outcome = null;
    try { outcome = await huntLoop(p); }
    catch (e) { log('hunt err: ' + e.message.slice(0, 60)); }

    if (outcome === 'dead') {
      stats.phase = 'respawning_after_death';
      stats.region = 'world';
      stats.queueAhead = null;
      stats.hp = 100;
      saveState();
      log('♻️ death recovery -> requeue same shard');
      expectedClose = true;
      try { p.close(); } catch {}
      await sleep(4000);
      continue;
    }

    // exit wild before reconnecting (safe)
    try { if (/^wild/.test(p.region)) { p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1); await sleep(2000); } } catch {}
    expectedClose = true;
    try { p.close(); } catch {}
    saveState();
    await sleep(4000);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
