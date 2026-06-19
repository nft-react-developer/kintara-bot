#!/usr/bin/env node
// ============ GATHER BOT — autopilot wood/stone/coal/metal (Path A, headless) ============
// Connect world -> learn nodes from res_evt -> walk adjacent -> harvestNode
// (harv->proof->harv_hit until felled) -> save-backpack loot -> repeat. Level
// woodcutting/mining. Supervisor reconnect, tahan 502.
//
// Usage: node tools/gather-bot.js [kind=tree|rock] [shard=s2]
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { Presence } = require('../lib/presenceWs');
const { KintaraClient } = require('../lib/kintaraClient');
const { isWalletBannedError } = require('../lib/walletAuth');
const gs = require('../lib/gameState');
const { pickInventorySnapshot } = require('../lib/inventorySnapshot');

const KIND = process.argv[2] || 'tree';
const SHARD = process.argv[3] || config.shard || 's4';
const OUT = path.join(__dirname, '..', 'recon');
const PIDFILE = path.join(OUT, 'control', 'gatherbot.pid');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'gather.log'), s + '\n'); };
const lt = {}; const logT = (k, m, ms = 30000) => { const n = Date.now(); if (!lt[k] || n - lt[k] > ms) { lt[k] = n; log(m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryDelayMs = (attempt, base = 5000, cap = 60000) => Math.min(cap, base * (2 ** Math.max(0, attempt - 1))) + Math.floor(Math.random() * 1500);
const TRANSIENT_FAILOVER_AFTER = 5;
const isTransientGatewayErr = (msg) => /503|Unexpected token '<'|<!doctype|Non-JSON|presence ws err/i.test(String(msg || ''));
const stats = {
  felled: 0,
  wood: 0,
  stone: 0,
  coal: 0,
  metal: 0,
  gainedWood: 0,
  gainedStone: 0,
  gainedCoal: 0,
  gainedMetal: 0,
  harvests: 0,
  reconnects: 0,
  started: Date.now(),
  skillXp: {},
};
function saveState(extra = {}) {
  fs.writeFileSync(path.join(OUT, 'gather-state.json'), JSON.stringify({
    ...stats,
    kind: KIND,
    region: extra.region || stats.region || 'world',
    phase: extra.phase || stats.phase || 'boot',
    queueAhead: extra.queueAhead != null ? extra.queueAhead : (stats.queueAhead ?? null),
    updatedAt: Date.now(),
    ageMin: Math.round((Date.now() - stats.started) / 60000),
  }, null, 2));
  if (extra.region !== undefined) stats.region = extra.region;
  if (extra.phase !== undefined) stats.phase = extra.phase;
  if (extra.queueAhead !== undefined) stats.queueAhead = extra.queueAhead;
}
function trackAccountMeta(me) {
  if (!me || (!me.ok && !me.player && !me.backpack && !me.meta)) return;
  stats.dailySpinnerLastMs = me?.meta?.dailySpinnerLastMs ?? null;
  if (me?.backpack) stats.inventory = pickInventorySnapshot(me.backpack);
}

let cli;
async function createClientWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await KintaraClient.create();
    } catch (e) {
      if (isWalletBannedError(e)) throw e;
      const waitMs = retryDelayMs(attempt);
      saveState({ phase: 'bootstrap_retry', queueAhead: null });
      log(`bootstrap attempt ${attempt} failed: ${String(e.message || e).slice(0, 50)} — retry ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}
async function connectWithRetry() {
  let transientGatewayFails = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const p = new Presence(SHARD);
      if (cli) p.setCookie(cli.cookie);
      p.on('log', (m) => log('[ws] ' + m));
      p.on('queue', (d) => {
        if (d.ahead % 5 === 0) log('queue ahead=' + d.ahead);
        saveState({ phase: 'queue', queueAhead: Number.isFinite(Number(d?.ahead)) ? Number(d.ahead) : null, region: p.region });
      });
      p.on('skill_xp', (xp) => {
        if (!xp) return;
        stats.skillXp = { ...stats.skillXp, ...xp };
        saveState({ region: p.region });
      });
      await p.connect();
      transientGatewayFails = 0;
      log('✅ presence live region=' + p.region);
      saveState({ phase: 'presence', queueAhead: null, region: p.region });
      return p;
    } catch (e) {
      if (isWalletBannedError(e)) throw e;
      if (isTransientGatewayErr(e.message)) transientGatewayFails++;
      else transientGatewayFails = 0;
      if (transientGatewayFails >= TRANSIENT_FAILOVER_AFTER) {
        saveState({ phase: 'failover_restart', queueAhead: null });
        log(`♻️ shard failover after ${transientGatewayFails} transient gateway errors`);
        throw new Error('transient_presence_failover');
      }
      saveState({ phase: 'reconnect', queueAhead: null });
      const waitMs = retryDelayMs(attempt);
      saveState({ phase: 'reconnect_wait', queueAhead: null });
      log(`connect attempt ${attempt} failed: ${e.message.slice(0, 50)} — retry ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}

async function persistLoot(loot, yld = 1) {
  try {
    const st = await gs.fetchState(cli); const bp = st.backpack; const slots = bp.invSlots || [];
    trackAccountMeta(st.raw);
    let put = false;
    for (const s of slots) if (s && s.t === loot) { s.n += yld; put = true; break; }
    if (!put) { const e = slots.findIndex((s) => !s); if (e >= 0) slots[e] = { t: loot, n: yld }; }
    bp[loot] = (Number(bp[loot]) || 0) + yld;
    const r = await gs.pushBackpack(cli, bp, st.stateSeq, []);
    stats[loot] = r?.backpack?.[loot] ?? stats[loot];
    if (r?.backpack) stats.inventory = pickInventorySnapshot(r.backpack);
    if (loot === 'wood') stats.gainedWood += yld;
    if (loot === 'stone') stats.gainedStone += yld;
    if (loot === 'coal') stats.gainedCoal += yld;
    if (loot === 'metal') stats.gainedMetal += yld;
    return true;
  } catch (e) { logT('persist', 'persist err: ' + e.message.slice(0, 50)); return false; }
}

async function gatherLoop(p) {
  const harvested = new Set();
  while (p.ready) {
    saveState({ phase: 'scan', queueAhead: null, region: p.region });
    const pool = KIND === 'all' ? [...p.knownNodes('tree'), ...p.knownNodes('rock')] : p.knownNodes(KIND);
    const nodes = pool.filter((n) => !harvested.has(n.key));
    if (!nodes.length) { logT('wait', 'waiting for nodes from res_evt...'); await sleep(5000); continue; }
    // choose the nearest node from the current position
    nodes.sort((a, b) => {
      const [ac, ar] = a.key.split(',').map(Number), [bc, br] = b.key.split(',').map(Number);
      const da = Math.abs(ac - 30.5 - p.pos.x) + Math.abs(ar - 30.5 - p.pos.z);
      const db = Math.abs(bc - 30.5 - p.pos.x) + Math.abs(br - 30.5 - p.pos.z);
      return da - db;
    });
    const node = nodes[0]; harvested.add(node.key);
    const [col, row] = node.key.split(',').map(Number);
    await p.walkTo(col - 30.5 - 1, row - 30.5, { maxSec: 20 });
    await sleep(1000);
    if (!p.ready) break;
    const res = await p.harvestNode(node.kind, node.key, node.hasCoal, node.hasMetal, { maxHits: 10, hitGap: 1700 });
    stats.harvests++;
    if (res.felled) { stats.felled++; await persistLoot(res.loot, 1); logT('fell', `🪓 felled ${node.kind} @${node.key} -> ${res.loot} (wood=${stats.wood} stone=${stats.stone} coal=${stats.coal} metal=${stats.metal}, felled ${stats.felled})`, 15000); }
    saveState({ phase: 'gather', queueAhead: null, region: p.region });
    await sleep(1500);
    if (harvested.size > 200) harvested.clear(); // reset so nodes can be re-harvested after respawn
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'control'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'gather.log'), '');
  fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, kind: KIND, shard: SHARD, started: Date.now() }));
  process.on('exit', () => { try { fs.unlinkSync(PIDFILE); } catch {} });
  saveState({ phase: 'boot', queueAhead: null, region: 'world' });
  const { client: c, player } = await createClientWithRetry(); cli = c;
  const st0 = await cli.playerStats(player?.id).catch(() => ({}));
  if (st0?.skillXp) stats.skillXp = { ...stats.skillXp, ...st0.skillXp };
  log('GATHER BOT START kind=' + KIND + ' pid=' + player?.id);
  for (;;) {
    const p = await connectWithRetry();
    p.on('close', () => { stats.reconnects++; saveState({ phase: 'reconnect', queueAhead: null, region: p.region }); log('⚠️ presence closed -> reconnect'); });
    await sleep(2000);
    // wait 8s so nodes from res_evt can accumulate
    saveState({ phase: 'learning', queueAhead: null, region: p.region });
    log('belajar node 8s...'); await sleep(8000);
    await gatherLoop(p);
    try { p.close(); } catch {}
    await sleep(3000);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
