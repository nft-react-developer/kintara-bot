#!/usr/bin/env node
// ============ TELEGRAM CONTROL BOT — headless bot control + status ============
// Kintara control bot via Telegram: status, skills, balance, quests, start/stop fishing.
// Uses lib/telegram (long-poll). Token+chatId come from .env (auto-captures chat id
// when the first message is sent to the bot).
//
// Usage: node tools/telegram-bot.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { config } = require('../config');
const tg = require('../lib/telegram');
const { KintaraClient } = require('../lib/kintaraClient');
const { levelFromTotalXp, formatSkillBandProgressShort, averageLevelFloor, preciseAverageLevel } = require('../lib/skillXp');
const { isWalletBannedError } = require('../lib/walletAuth');
const { Presence } = require('../lib/presenceWs');
const { getErrors } = require('../lib/errorbus');
const {
  POTION_TYPES,
  POTION_LABELS,
  normalizePotionType,
  parsePotionQuantity,
  potionResourceSnapshot,
  fetchPotionCatalog,
  formatPotionResources,
  formatPotionRecipes,
} = require('../lib/potionCommand');
const {
  formatListingUnitPrice,
  MARKET_CATEGORIES,
} = require('../lib/marketplaceView');
const {
  MERCHANT_TRADE_COST,
  merchantResourceSnapshot,
  fetchMerchantTradeCost,
  merchantTradeEnabled,
  maxMerchantTrades,
  merchantWatcherButtons,
  formatMerchantStatus,
} = require('../lib/merchantCommand');
const {
  readMerchantWatcherState,
  writeMerchantWatcherState,
  createMerchantLogger,
  applyMerchantWatcherAction,
  runMerchantWatcherTick,
  createNonOverlappingPoller,
} = require('../lib/merchantRuntime');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const PIDFILE = path.join(OUT, 'control', 'fishbot.pid');
const GPIDFILE = path.join(OUT, 'control', 'gatherbot.pid');
const OPIDFILE = path.join(OUT, 'control', 'orch.pid');
const CPIDFILE = path.join(OUT, 'control', 'combatbot.pid');
const PPIDFILE = path.join(OUT, 'control', 'potionbot.pid');
const MPIDFILE = path.join(OUT, 'control', 'merchantbot.pid');
const TGPIDFILE = path.join(OUT, 'control', 'telegram.pid');
const POTION_JOBFILE = path.join(OUT, 'control', 'potion-job.json');
const POTION_RESULTFILE = path.join(OUT, 'control', 'potion-result.json');
const MERCHANT_WATCHER_STATEFILE = path.join(OUT, 'control', 'merchant-watcher.json');
const MERCHANT_JOBFILE = path.join(OUT, 'control', 'merchant-job.json');
const MERCHANT_RESULTFILE = path.join(OUT, 'control', 'merchant-result.json');
const MERCHANT_JOB_STATEFILE = path.join(OUT, 'control', 'merchant-job-state.json');
const MERCHANT_LOGFILE = path.join(OUT, 'merchant.log');
const VERSION_STATEFILE = path.join(OUT, 'game-version-state.json');
const AUTOREVIVE_STATEFILE = path.join(OUT, 'control', 'autorevive.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VERSION_POLL_MS = 10 * 60 * 1000;
const KEEPALIVE_POLL_MS = 20 * 1000;
const MERCHANT_POLL_MS = 5 * 1000;
const MERCHANT_COST_CACHE_MS = 10 * 60 * 1000;
const AUTO_VERSION_REVIEW = (process.env.KINTARA_AUTO_VERSION_REVIEW || 'true').toLowerCase() !== 'false';
const VERSION_REVIEW_TIMEOUT_MS = parseInt(process.env.KINTARA_VERSION_REVIEW_TIMEOUT_MS || '45000', 10);

let cli = null, lastAuth = 0, myPid = null;
let activeVersionReviewSha = null;
const merchantLog = createMerchantLogger(MERCHANT_LOGFILE);
async function client() {
  if (!cli) { const { client: c, player } = await KintaraClient.create(); cli = c; myPid = player?.id || myPid; lastAuth = Date.now(); }
  return cli;
}
async function ensureLoginOk() {
  try {
    await client();
    return null;
  } catch (e) {
    if (isWalletBannedError(e)) {
      return '⛔ This wallet is banned by the server (`wallet_banned`). The bot cannot log in or run with this wallet. Please check the in-game account status or contact official support.';
    }
    throw e;
  }
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

// Choose the lowest-queue shard this wallet CAN enter (gate=ok).
// Build 1ce1fc76 added entry-gate /api/auth/gate-check (membership/level/$KINS).
// Accounts below level 20 and without membership are always rejected from s1-s3. Therefore set
// Hard floor: only choose shards >= KINTARA_MIN_SHARD (default 4). Gate-check remains
// as a second layer so it automatically follows server map changes.
const MIN_SHARD = Math.max(1, parseInt(process.env.KINTARA_MIN_SHARD || '4', 10) || 4);
let _bestShardCache = { ts: 0, shard: null };
async function shardGateOk(c, id) {
  try {
    const r = await c.get(`/api/auth/gate-check?shard=${Number(id) | 0}`);
    return r && r.gate === 'ok';
  } catch (e) {
    // 403 = gate rejected (membership/level/KINS). Anything else (network) -> unknown.
    if (e && e.status === 403) return false;
    return null; // unknown -> do not exclude immediately; let fallback decide
  }
}
async function pickBestShard(force = false) {
  if (!force && Date.now() - _bestShardCache.ts < 60000 && _bestShardCache.shard) return _bestShardCache.shard;
  try {
    const c = await client();
    const r = await c.servers();
    const list = (r.servers || []).filter((x) => x && x.id != null);
    if (!list.length) return null;
    // manual override: skip the floor and gate check (for example, premium or level 20)
    const bypass = process.env.KINTARA_ALLOW_LOW_SERVERS === '1';
    // FLOOR: discard s1..s(MIN_SHARD-1) unless bypassed.
    const eligible = bypass ? list : list.filter((x) => Number(x.id) >= MIN_SHARD);
    const base = eligible.length ? eligible : list;
    // Prefer non-full servers first, then the shortest queue. A full server with queue=0 is an anomaly;
    // place it after non-full servers but before full servers with queue>0.
    const ranked = [...base].sort((a, b) => {
      const aFull = !!a.full, bFull = !!b.full;
      if (aFull !== bFull) return aFull ? 1 : -1;
      return (Number(a.queueLength || 0) - Number(b.queueLength || 0));
    });
    if (bypass) {
      const shard0 = 's' + ranked[0].id;
      _bestShardCache = { ts: Date.now(), shard: shard0 };
      return shard0;
    }
    // live gate-check probe; take the first shard (lowest queue) with gate=ok
    for (const sv of ranked) {
      const ok = await shardGateOk(c, sv.id);
      if (ok === true) {
        const shard = 's' + sv.id;
        _bestShardCache = { ts: Date.now(), shard };
        return shard;
      }
    }
    // all gates rejected / unreachable -> fallback: lowest-queue shard >= floor
    const best = ranked[0];
    const shard = 's' + best.id;
    _bestShardCache = { ts: Date.now(), shard };
    return shard;
  } catch { return null; }
}
async function resolveShard() {
  const best = await pickBestShard();
  return best || config.shard || 's4';
}

function pidOf(f) {
  const p = readJson(f);
  if (!p?.pid) return null;
  try {
    process.kill(p.pid, 0);
    return p.pid;
  } catch {
    try { fs.unlinkSync(f); } catch {}
    return null;
  }
}
function botPid() { return pidOf(PIDFILE); }
function gatherPid() { return pidOf(GPIDFILE); }
function combatPid() { return pidOf(CPIDFILE); }
function potionPid() { return pidOf(PPIDFILE); }
function merchantPid() { return pidOf(MPIDFILE); }
function stopPidfile(pf) {
  const pid = pidOf(pf);
  if (!pid) return null;
  try { process.kill(pid, 'SIGKILL'); } catch {}
  try { fs.unlinkSync(pf); } catch {}
  return pid;
}
function stopAllMainBots() {
  return {
    auto: stopPidfile(OPIDFILE),
    fish: stopPidfile(PIDFILE),
    gather: stopPidfile(GPIDFILE),
    combat: stopPidfile(CPIDFILE),
  };
}
function fmtAgeMin(min) {
  if (min == null || Number.isNaN(Number(min))) return '?';
  const total = Math.max(0, Math.round(Number(min)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}j ${m}m` : `${m}m`;
}
function activityLabel(name, gatherKind = null) {
  if (name === 'fish') return '🎣 Fishing';
  if (name === 'gather') {
    if (gatherKind === 'rock') return '⛏ Mining';
    if (gatherKind === 'tree') return '🪓 Woodcut';
    return '🪓⛏ Gather All';
  }
  if (name === 'combat') return '⚔️ Combat';
  if (name === 'auto') return '🧠 Auto';
  if (name === 'potion') return '🧪 Potion purchase';
  if (name === 'merchant') return '🧓 Traveling Merchant';
  return 'Idle';
}
function procAgeMin(f) {
  const p = readJson(f);
  if (!p?.started) return null;
  return Math.round((Date.now() - p.started) / 60000);
}
function isFreshState(state, maxAgeMs = 20 * 60 * 1000) {
  if (!state || typeof state !== 'object') return false;
  const started = Number(state.started);
  if (!Number.isFinite(started) || started <= 0) return false;
  return (Date.now() - started) <= maxAgeMs;
}
function scriptPath(script) {
  return path.join(ROOT, 'tools', script);
}
function killDuplicateScriptProcesses(script) {
  const target = scriptPath(script);
  try {
    const rows = cp.execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const row of rows) {
      const m = row.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const args = m[2];
      if (!pid || pid === process.pid) continue;
      if (args.includes(target) || args.includes(`tools/${script}`)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  } catch {}
}
function spawnBot(script, args, pidfile) {
  killDuplicateScriptProcesses(script);
  const child = cp.spawn('node', [scriptPath(script), ...args], { detached: true, stdio: 'ignore', cwd: ROOT });
  child.unref(); fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, started: Date.now() }));
  return child.pid;
}
function readAutoreviveState() {
  const state = readJson(AUTOREVIVE_STATEFILE);
  return state && typeof state === 'object' ? state : {};
}
function saveAutoreviveState(state) {
  fs.writeFileSync(AUTOREVIVE_STATEFILE, JSON.stringify(state, null, 2));
}
function normalizeDesiredState(state) {
  if (!state || typeof state !== 'object') return {};
  const next = { ...state };
  if (next.auto) {
    delete next.fish;
    delete next.gather;
    delete next.combat;
    return next;
  }
  const main = ['combat', 'gather', 'fish'].find((name) => next[name]);
  if (main) {
    for (const name of ['fish', 'gather', 'combat']) {
      if (name !== main) delete next[name];
    }
  }
  return next;
}
function setDesired(service, entry) {
  const state = normalizeDesiredState(readAutoreviveState());
  state[service] = { ...entry, updatedAt: Date.now() };
  saveAutoreviveState(normalizeDesiredState(state));
}
function clearDesired(...services) {
  const state = readAutoreviveState();
  let dirty = false;
  for (const service of services) {
    if (Object.prototype.hasOwnProperty.call(state, service)) {
      delete state[service];
      dirty = true;
    }
  }
  if (dirty) saveAutoreviveState(state);
}
function replaceMainDesired(service, entry) {
  clearDesired('fish', 'gather', 'auto', 'combat');
  setDesired(service, entry);
}
function syncDesiredFromLive() {
  const state = normalizeDesiredState(readAutoreviveState());
  let dirty = false;
  const manualDesired = !!(state.fish || state.gather || state.combat);
  if (pidOf(OPIDFILE) && !state.auto && !manualDesired) { state.auto = { updatedAt: Date.now() }; dirty = true; }
  if (!state.auto) {
    if (botPid() && !state.fish) { state.fish = { updatedAt: Date.now() }; dirty = true; }
    if (gatherPid() && !state.gather) {
      state.gather = { kind: readJson(GPIDFILE)?.kind || 'tree', updatedAt: Date.now() };
      dirty = true;
    }
    if (combatPid() && !state.combat) { state.combat = { updatedAt: Date.now() }; dirty = true; }
  } else {
    const normalized = normalizeDesiredState(state);
    if (JSON.stringify(normalized) !== JSON.stringify(state)) {
      dirty = true;
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, normalized);
    }
  }
  // If state is still empty and no process is running, remain idle (the user starts it manually).
  // If orphaned processes are running without a desired state, adopt them.
  if (!dirty && Object.keys(state).length === 0) {
    const live = liveMainService();
    if (live) {
      if (live === 'auto') state.auto = { updatedAt: Date.now() };
      else if (live === 'fish') state.fish = { updatedAt: Date.now() };
      else if (live === 'gather') state.gather = { kind: readJson(GPIDFILE)?.kind || 'all', updatedAt: Date.now() };
      else if (live === 'combat') state.combat = { updatedAt: Date.now() };
      dirty = true;
    }
  }
  if (dirty) saveAutoreviveState(normalizeDesiredState(state));
}
async function desiredServiceSpec(name, meta = {}) {
  const shard = await resolveShard();
  if (name === 'fish') return { script: 'bot-headless.js', args: [shard], pidfile: PIDFILE, label: 'Fishing bot', shard };
  if (name === 'gather') return { script: 'gather-bot.js', args: [meta.kind || 'tree', shard], pidfile: GPIDFILE, label: meta.kind === 'rock' ? 'Mining bot' : 'Gather bot', shard };
  if (name === 'auto') return { script: 'orchestrator.js', args: [], pidfile: OPIDFILE, label: 'Orchestrator', shard };
  if (name === 'combat') return { script: 'combat-bot.js', args: [shard], pidfile: CPIDFILE, label: 'Combat bot', shard };
  return null;
}
function liveMainService() {
  if (pidOf(OPIDFILE)) return 'auto';
  if (combatPid()) return 'combat';
  if (gatherPid()) return 'gather';
  if (botPid()) return 'fish';
  return null;
}
function stopMainService(name) {
  if (name === 'auto') return stopPidfile(OPIDFILE);
  if (name === 'combat') return stopPidfile(CPIDFILE);
  if (name === 'gather') return stopPidfile(GPIDFILE);
  if (name === 'fish') return stopPidfile(PIDFILE);
  return null;
}
async function ensureDesiredServices({ allowMerchantRestore = false, requireMerchantJob = false } = {}) {
  if (!allowMerchantRestore && (merchantPid() || merchantMonitorRunning)) return;
  if (requireMerchantJob && !readJson(MERCHANT_JOBFILE)) return;
  const state = normalizeDesiredState(readAutoreviveState());
  saveAutoreviveState(state);
  const desiredMain = state.auto ? 'auto' : state.combat ? 'combat' : state.gather ? 'gather' : state.fish ? 'fish' : null;
  const liveMain = liveMainService();
  if (desiredMain && liveMain && liveMain !== desiredMain) {
    stopMainService(liveMain);
  }
  for (const [name, meta] of Object.entries(state)) {
    const spec = await desiredServiceSpec(name, meta);
    if (!spec) continue;
    if (requireMerchantJob && !readJson(MERCHANT_JOBFILE)) return;
    if (name === 'gather' && pidOf(spec.pidfile)) {
      const liveMeta = readJson(spec.pidfile) || {};
      if ((liveMeta.kind || 'tree') !== (meta.kind || 'tree')) {
        stopMainService('gather');
      }
    }
    if (pidOf(spec.pidfile)) continue;
    const pid = spawnBot(spec.script, spec.args, spec.pidfile);
    if (name === 'gather') {
      fs.writeFileSync(spec.pidfile, JSON.stringify({ pid, kind: meta.kind || 'tree', started: Date.now() }));
    }
    await tg.send(`♻️ ${spec.label} auto-restarted (pid ${pid}) on shard ${spec.shard || '?'}`).catch(() => {});
  }
}
function readVersionState() { return readJson(VERSION_STATEFILE) || {}; }
function saveVersionState(data) {
  try { fs.writeFileSync(VERSION_STATEFILE, JSON.stringify({ ...data, checkedAt: Date.now() }, null, 2)); } catch {}
}
function markVersionVerified(sha, notes = []) {
  const prev = readVersionState();
  saveVersionState({
    ...prev,
    sha: sha || prev.sha || null,
    verifiedSha: sha || prev.sha || null,
    verifiedAt: Date.now(),
    verifiedNotes: Array.isArray(notes) ? notes.filter(Boolean) : [],
  });
}
function versionVerificationSummary(state, currentSha) {
  if (!state?.verifiedSha || !currentSha || state.verifiedSha !== currentSha) {
    return 'compat: review pending';
  }
  const at = state.verifiedAt
    ? new Date(state.verifiedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    : 'unknown';
  const notes = Array.isArray(state.verifiedNotes) && state.verifiedNotes.length
    ? ` • ${state.verifiedNotes.join(', ')}`
    : '';
  return `compat: verified ${String(currentSha).slice(0, 8)} @ ${at}${notes}`;
}
function currentVersionReviewStatus(state, currentSha) {
  if (!state || !currentSha || state.reviewSha !== currentSha) return null;
  if (state.reviewStatus === 'running') return 'review: auto-smoke running';
  if (state.reviewStatus === 'failed') {
    const tail = state.reviewError ? ` (${String(state.reviewError).slice(0, 80)})` : '';
    return `review: auto-smoke needs manual check${tail}`;
  }
  if (state.reviewStatus === 'passed') return 'review: auto-smoke passed';
  return null;
}
async function fetchGameVersion() {
  const c = await client();
  const v = await c.version().catch(() => ({}));
  return { sha: v?.sha || null, ok: !!v?.ok };
}
async function smokeCheckPresence(shard, timeoutMs = VERSION_REVIEW_TIMEOUT_MS) {
  const p = new Presence(shard);
  let queueAhead = null;
  let reachedQueue = false;
  p.on('queue', (d) => {
    reachedQueue = true;
    const ahead = Number(d?.ahead);
    if (Number.isFinite(ahead)) queueAhead = ahead;
  });
  try {
    await Promise.race([
      p.connect(),
      new Promise((_, reject) => setTimeout(() => {
        // Reaching the queue = gate PASSED (auth+membership/level+$KINS all ok).
        // Real player wait is ~8-15min; we don't sit through it in a smoke check.
        // Only a timeout BEFORE any queue_pos is a genuine failure.
        if (reachedQueue) {
          const e = new Error('queued'); e.queued = true; e.queueAhead = queueAhead;
          reject(e);
        } else {
          reject(new Error(`presence timeout${queueAhead != null ? ` (queue ${queueAhead})` : ''}`));
        }
      }, timeoutMs)),
    ]);
    return { shard, region: p.region, queueAhead, queued: false };
  } catch (e) {
    if (e && e.queued) return { shard, region: p.region, queueAhead, queued: true };
    throw e;
  } finally {
    try { p.close(); } catch {}
  }
}
async function runAutoVersionReview(sha) {
  if (!sha || activeVersionReviewSha === sha) return;
  activeVersionReviewSha = sha;
  const prev = readVersionState();
  saveVersionState({
    ...prev,
    reviewSha: sha,
    reviewStatus: 'running',
    reviewAt: Date.now(),
    reviewError: null,
  });
  (async () => {
    const notes = [];
    const lines = [`🧪 Auto review started for \`${String(sha).slice(0, 8)}\``];
    try {
      const { client: c } = await KintaraClient.create();
      lines.push('• auth/login OK');
      const version = await c.version();
      if (!version?.sha) throw new Error('version endpoint returned no SHA');
      if (version.sha !== sha) throw new Error(`SHA changed again to ${String(version.sha).slice(0, 8)}`);
      notes.push('rest');
      lines.push(`• /api/version OK (${String(version.sha).slice(0, 8)})`);
      const me = await c.me();
      if (!me?.player?.id) throw new Error('auth/me missing player payload');
      lines.push(`• /api/auth/me OK (player ${me.player.id})`);
      const market = await c.marketplaceStats('fish');
      if (market?.ok === false) throw new Error('marketplace stats rejected');
      lines.push('• basic endpoint OK (/api/marketplace/stats)');
      const presence = await smokeCheckPresence(await resolveShard());
      notes.push('presence');
      lines.push(presence.queued
        ? `• presence OK (${presence.shard}, reached queue${presence.queueAhead != null ? ` — ${presence.queueAhead} ahead` : ''}; gate passed)`
        : `• presence OK (${presence.shard}${presence.queueAhead != null ? `, queue ${presence.queueAhead}` : ''}, region ${presence.region})`);
      markVersionVerified(sha, [...new Set([...notes, 'basic', 'smoke-auto'])]);
      const next = readVersionState();
      saveVersionState({
        ...next,
        reviewSha: sha,
        reviewStatus: 'passed',
        reviewAt: Date.now(),
        reviewError: null,
      });
      await tg.send(`${lines.join('\n')}\n\n✅ Auto review PASSED.\nAutomation remains paused until you start it manually again.`).catch(() => {});
    } catch (e) {
      const next = readVersionState();
      saveVersionState({
        ...next,
        reviewSha: sha,
        reviewStatus: 'failed',
        reviewAt: Date.now(),
        reviewError: e.message,
      });
      await tg.send(`${lines.join('\n')}\n\n⚠️ Auto review did not fully pass: ${(e.message || '').slice(0, 160)}\nBot remains paused. Manual review is needed before starting again.`).catch(() => {});
    } finally {
      activeVersionReviewSha = null;
    }
  })().catch(() => { activeVersionReviewSha = null; });
}
async function maybeNotifyVersionChange() {
  try {
    const current = await fetchGameVersion();
    if (!current.sha) return;
    const prev = readVersionState();
    const changed = !!(prev.sha && prev.sha !== current.sha);
    saveVersionState({
      sha: current.sha,
      previousSha: changed ? prev.sha : (prev.previousSha || null),
      lastChangedAt: changed ? Date.now() : (prev.lastChangedAt || null),
      notifiedSha: changed ? current.sha : (prev.notifiedSha || null),
      verifiedSha: changed ? null : (prev.verifiedSha || null),
      verifiedAt: changed ? null : (prev.verifiedAt || null),
      verifiedNotes: changed ? [] : (prev.verifiedNotes || []),
    });
    if (prev.sha && prev.sha !== current.sha) {
      clearDesired('fish', 'gather', 'auto', 'combat');
      const stopped = stopAllMainBots();
      const stoppedPotion = cancelPotionJob();
      const stoppedMerchant = stopPidfile(MPIDFILE);
      if (stoppedMerchant || merchantWatcherState().enabled !== false) {
        saveMerchantWatcherState({ enabled: false, pausePending: false });
        try { fs.unlinkSync(MERCHANT_JOBFILE); } catch {}
        merchantLog('watcher_paused', { source: 'game_update', sha: current.sha });
      }
      const stoppedNames = [
        stopped.auto ? 'auto' : null,
        stopped.fish ? 'fish' : null,
        stopped.gather ? 'gather' : null,
        stopped.combat ? 'combat' : null,
        stoppedPotion ? 'potions' : null,
        stoppedMerchant ? 'merchant' : null,
      ].filter(Boolean);
      const stopLine = stoppedNames.length
        ? `\n🛑 Automation auto-paused: ${stoppedNames.join(', ')}`
        : '\n🛑 No active bots were running when the update was detected.';
      await tg.send(`🆕 Game update detected\nold: \`${prev.sha.slice(0, 8)}\`\nnew: \`${current.sha.slice(0, 8)}\`${stopLine}\nPlease review the bot / API before starting automation again.`).catch(() => {});
      if (AUTO_VERSION_REVIEW) runAutoVersionReview(current.sha);
    }
  } catch {}
}

// ---------- handlers ----------
async function hStatus() {
  const fr = botPid(), gr = gatherPid(), cb = combatPid(), pp = potionPid(), mp = merchantPid(), or = pidOf(OPIDFILE);
  const gatherMeta = readJson(GPIDFILE) || {};
  const gatherState = readJson(path.join(OUT, 'gather-state.json'));
  const gatherKind = gatherMeta?.kind || gatherState?.kind || 'all';
  const gLbl = gatherKind === 'rock' ? '⛏ Mining' : gatherKind === 'tree' ? '🪓 Wood' : '🪓⛏ Gather';
  const orch = readJson(path.join(OUT, 'orchestrator-state.json'));
  const active = mp ? 'merchant' : pp ? 'potion' : cb ? 'combat' : gr ? 'gather' : fr ? 'fish' : or ? (orch?.current || 'auto') : 'idle';
  const activeLabel = activityLabel(active, gatherKind);
  const activeAge = active === 'fish'
    ? fmtAgeMin(procAgeMin(PIDFILE))
    : active === 'gather'
      ? fmtAgeMin(procAgeMin(GPIDFILE))
      : active === 'combat'
        ? fmtAgeMin(procAgeMin(CPIDFILE))
        : active === 'potion'
          ? fmtAgeMin(procAgeMin(PPIDFILE))
          : active === 'merchant'
            ? fmtAgeMin(procAgeMin(MPIDFILE))
        : null;
  const lines = [
    '🤖 <b>Kintara Bot Status</b>',
    `🎯 <b>Active:</b> ${activeLabel}${activeAge ? ` • ${activeAge}` : ''}`,
    `🧠 Auto ${or ? '🟢 ON' : '🔴 OFF'} | 🎣 Fish ${fr ? '🟢' : '🔴'} | ${gLbl} ${gr ? '🟢' : '🔴'} | ⚔️ Combat ${cb ? '🟢' : '🔴'} | 🧪 Potions ${pp ? '🟢' : '🔴'} | 🧓 Merchant ${mp ? '🟢' : '🔴'}`,
  ];
  if (or && orch) {
    lines.push('');
    lines.push(`🧠 <b>Auto Mode</b>`);
    lines.push(`• now: ${activityLabel(orch.current, gatherKind)}`);
    lines.push(`• why: ${orch.currentWhy || orch.desiredWhy || '-'}`);
    if (orch.desiredGoal && orch.desiredGoal !== orch.current) {
      lines.push(`• next: ${activityLabel(orch.desiredGoal, gatherKind)}`);
      lines.push(`• hold: ${orch.desiredWhy || '-'}${orch.holdReason ? ` • ${orch.holdReason}` : ''}`);
    }
  }
  const s = readJson(path.join(OUT, 'bot-state.json'));
  const g = gatherState;
  const cs = readJson(path.join(OUT, 'combat-state.json'));
  lines.push('');
  lines.push('📦 <b>Session</b>');
  if (fr && s && isFreshState(s)) {
    const fishPhaseMap = {
      boot: 'boot',
      queue: s.queueAhead != null ? `queue ${s.queueAhead}` : 'queue',
      presence: 'presence',
      travel_pond: 'travel pond',
      pond: 'pond',
      fishing: 'fishing',
      reconnect: 'reconnect',
    };
    const fishPhase = s.phase ? (fishPhaseMap[s.phase] || s.phase) : null;
    lines.push(`🎣 fish ${s.ok || 0}/${s.casts || 0} | 🎒 ${s.fish || 0} | 🍳 ${s.cooked || 0} | 💰 ${s.sold || 0}${fishPhase ? ` | 📍 ${fishPhase}` : ''} | ⏱ ${fmtAgeMin(s.ageMin)}`);
  }
  if (gr && g && isFreshState(g, 60 * 60 * 1000)) {
    const phaseLabel = g.phase === 'queue'
      ? (g.queueAhead != null ? `queue ${g.queueAhead}` : 'queue')
      : g.phase || null;
    lines.push(`🪓 felled ${g.felled || 0} | 🪵 ${g.wood || 0} (+${g.gainedWood || 0}) | 🪨 ${g.stone || 0} (+${g.gainedStone || 0}) | ⬛ ${g.coal || 0} (+${g.gainedCoal || 0}) | 🔩 ${g.metal || 0} (+${g.gainedMetal || 0})${phaseLabel ? ` | 📍 ${phaseLabel}` : ''} | ⏱ ${fmtAgeMin(g.ageMin)}`);
  }
  if (cb && cs && isFreshState(cs, 60 * 60 * 1000)) {
    const phaseMap = {
      boot: 'boot',
      prep: 'prep',
      queue: cs.queueAhead != null ? `queue ${cs.queueAhead}` : 'queue',
      respawning_after_death: 'respawning after death',
      requeue_after_death: cs.queueAhead != null ? `requeue after death ${cs.queueAhead}` : 'requeue after death',
      presence: 'presence',
      wild: 'wild',
      hunt: 'hunt',
      retreat: 'retreat',
      exit: 'exit',
      dead: 'dead',
      reconnect: 'reconnect',
    };
    const phaseLabel = cs.phase ? (phaseMap[cs.phase] || cs.phase) : null;
    lines.push(`⚔️ kill ${cs.kills || 0} | 🗡️ ${cs.hits || 0} | 🎒 ${cs.lootClaims || 0} | 📈 +${cs.combatGain || 0}XP | ❤️ ${cs.hp || 0} | 🧪 ${cs.potionsHealth || 0}H/${cs.potionsShield || 0}S | 🏃 ${cs.retreats || 0}${phaseLabel ? ` | 📍 ${phaseLabel}` : ''} | ⏱ ${fmtAgeMin(cs.ageMin)}`);
  }
  if (!(fr && s && isFreshState(s)) && !(gr && g && isFreshState(g, 60 * 60 * 1000)) && !(cb && cs && isFreshState(cs, 60 * 60 * 1000))) {
    lines.push('No fresh session stats yet for the currently running activity.');
  }
  return lines.join('\n');
}
function fmtSpinnerReady(lastMs) {
  const COOLDOWN = 12 * 3600 * 1000;
  const next = (Number(lastMs) || 0) + COOLDOWN;
  const left = next - Date.now();
  if (left <= 0) return '🎡 Spinner: ✅ FREE SPIN READY — type /spinner';
  const h = Math.floor(left / 3600000);
  const m = Math.round((left % 3600000) / 60000);
  return `🎡 Spinner: ⏳ ready in ${h}h ${m}m`;
}
async function hSkills() {
  const c = await client(); const st = await c.playerStats(myPid).catch(() => ({}));
  const xp = st.skillXp || {};
  let spinLine;
  let dailySpinnerLastMs = null;
  try {
    const me = await c.me();
    dailySpinnerLastMs = me?.meta?.dailySpinnerLastMs ?? null;
    spinLine = fmtSpinnerReady(me?.meta?.dailySpinnerLastMs);
  } catch { spinLine = '🎡 Spinner: status ?'; }
  const avg = Number.isFinite(Number(st.avg)) ? Number(st.avg) : averageLevelFloor(xp);
  const avgPrecise = preciseAverageLevel(xp).toFixed(2);
  try {
    fs.writeFileSync(path.join(OUT, 'skills-state.json'), JSON.stringify({
      skillXp: xp,
      avg,
      avgPrecise: Number(avgPrecise),
      dailySpinnerLastMs,
      updatedAt: Date.now(),
    }, null, 2));
  } catch {}
  const unlock = avg >= 5 ? '✅ spinner unlocked' : `🔒 spinner requires avg 5 (now ${avg})`;
  const line = (icon, key, label) => {
    const val = xp[key] || 0;
    return `${icon} ${label}: lvl ${levelFromTotalXp(val)} • ${formatSkillBandProgressShort(val)}`;
  };
  return `📊 <b>Stats</b> (avg lvl ${avg} • precise ${avgPrecise})\n` +
    `${line('⚔️', 'combat', 'combat')}\n` +
    `${line('🪓', 'woodcutting', 'woodcutting')}\n` +
    `${line('⛏', 'mining', 'mining')}\n` +
    `${line('🎣', 'fishing', 'fishing')}\n` +
    `${line('🍳', 'cooking', 'cooking')}\n` +
    `${line('🔨', 'smithing', 'smithing')}\n` +
    `${spinLine}\n${unlock}`;
}
async function hBalance() {
  const c = await client(); const me = await c.me(); const bp = me.backpack || {};
  const invItems = (bp.invSlots || [])
    .filter(Boolean)
    .map((slot) => `${slot.t}:${slot.n || 0}`);
  let tok = '';
  try { const t = await c.tokenBlimpStats(); tok = `\n🪙 $KINS: $${t.priceUsd} (${t.marketCapLabel})`; } catch {}
  const invLine = invItems.length ? invItems.join(' | ') : '-';
  return `💰 <b>Balance</b>\ngold: ${bp.gold || 0}\n🎣 fish: ${bp.fish || 0} | 🍳 cooked: ${bp.cooked_fish_meat || 0}\n🪵 wood: ${bp.wood || 0} | 🪨 stone: ${bp.stone || 0} | coal: ${bp.coal || 0} | metal: ${bp.metal || 0}\n🎒 inv ${(bp.invSlots || []).filter(Boolean).length}/24\n📦 items: ${invLine}${tok}`;
}
async function hSpinner() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  const c = await client();
  // Gate: requires avg level >= 5 (server-side, from playerStats.avg)
  try {
    const st = await c.playerStats(myPid);
    const avg = Number(st?.avg);
    if (Number.isFinite(avg) && avg < 5) {
      return `🔒 Spinner requires avg level ≥ 5 (current ${avg}). Grind a bit more first.`;
    }
  } catch {}
  // Free daily spin
  let res;
  try {
    res = await c.dailySpinnerSpin();
  } catch (e) {
    const m = (e.message || '').toLowerCase();
    if (/cooldown|12h|already|wait|next|timer/.test(m)) {
      return `⏳ Free spin is not ready yet (12h cooldown). Try again later.`;
    }
    return `❌ Spin failed: ${(e.message || '').slice(0, 120)}`;
  }
  if (!res || res.ok === false) {
    return `❌ Spin rejected by server: ${JSON.stringify(res || {}).slice(0, 120)}`;
  }
  const grant = res.grant || {};
  const bp = res.backpack || {};
  const prizeIcon = { gold: '🪙', wood: '🪵', stone: '🪨', coal: '⚫', metal: '🔩', fish: '🎣' }[grant.type] || '🎁';
  let tickerLine = '';
  try {
    const t = await c.spinnerPaidTicker();
    const tk = t?.ticker || {};
    if (tk.priceUsd) tickerLine = `\n💵 Paid spin: $${tk.paidSpinUsd || 3} (~${tk.tokenSymbol || '$KINS'} @ $${Number(tk.priceUsd).toFixed(6)})`;
  } catch {}
  return `🎡 <b>Free Spin!</b>\n${prizeIcon} Won: <b>${grant.type || '?'}</b> x${grant.amount ?? '?'} (segment #${res.winIndex ?? '?'})\n` +
    `🎒 Backpack: 🪵 ${bp.wood || 0} | 🪨 ${bp.stone || 0} | ⚫ ${bp.coal || 0} | 🔩 ${bp.metal || 0} | 🪙 ${bp.gold || 0}` +
    `${tickerLine}\n\n<i>Free spin resets every 12 hours.</i>`;
}

const POTION_SESSION_TTL_MS = 10 * 60 * 1000;
let potionSession = null;
let potionMonitorRunning = false;

let merchantMonitorRunning = false;
let merchantCampaignSignature = null;
let merchantCostCache = null;
let merchantCostCachedAt = 0;
let merchantLastPollError = null;
let merchantLastPollErrorAt = 0;

function merchantWatcherState() {
  return readMerchantWatcherState(MERCHANT_WATCHER_STATEFILE);
}

function saveMerchantWatcherState(update) {
  const current = merchantWatcherState();
  return writeMerchantWatcherState(MERCHANT_WATCHER_STATEFILE, { ...current, ...update });
}

async function currentMerchantCost(force = false) {
  if (!force && merchantCostCache && Date.now() - merchantCostCachedAt < MERCHANT_COST_CACHE_MS) {
    return merchantCostCache;
  }
  const c = await client();
  merchantCostCache = await fetchMerchantTradeCost(c.apiBase);
  merchantCostCachedAt = Date.now();
  return merchantCostCache;
}

async function fetchMerchantSnapshot({ forceCost = false, forWatcher = false } = {}) {
  const c = await client();
  let knownCampaign = null;
  if (forWatcher) {
    knownCampaign = await c.merchantCampaign();
    if (!merchantTradeEnabled(knownCampaign) || Number(knownCampaign.goldStock) <= 0) {
      return { campaign: knownCampaign, resources: null, cost: merchantCostCache || MERCHANT_TRADE_COST, maxTrades: 0 };
    }
  }
  const [campaign, me, cost] = await Promise.all([
    knownCampaign || c.merchantCampaign(),
    c.me(),
    currentMerchantCost(forceCost),
  ]);
  const resources = merchantResourceSnapshot(me?.backpack || {});
  return { campaign, resources, cost, maxTrades: maxMerchantTrades(resources, campaign, cost) };
}

function merchantActiveJob() {
  if (!merchantPid() && !merchantMonitorRunning) return null;
  const job = readJson(MERCHANT_JOBFILE) || {};
  const state = readJson(MERCHANT_JOB_STATEFILE) || {};
  return {
    ...job,
    phase: state.phase || 'starting',
    resumeLabel: activityLabel(job.resumeService || null, job.resumeDesired?.gather?.kind),
  };
}

async function merchantStatusMessage({ forceCost = false } = {}) {
  const state = merchantWatcherState();
  const job = merchantActiveJob();
  try {
    const snapshot = await fetchMerchantSnapshot({ forceCost });
    return {
      text: formatMerchantStatus({ state, job, ...snapshot }),
      buttons: merchantWatcherButtons(state),
    };
  } catch (error) {
    merchantLog('manual_refresh_failed', { reason: String(error?.message || error).slice(0, 160) });
    return {
      text: formatMerchantStatus({ state, job, cost: merchantCostCache || MERCHANT_TRADE_COST, error: error?.message || error }),
      buttons: merchantWatcherButtons(state),
    };
  }
}

async function hMerchant() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  const view = await merchantStatusMessage();
  await tg.send(view.text, { buttons: view.buttons });
  return null;
}

async function editMerchantStatus(ctx, opts = {}) {
  const view = await merchantStatusMessage(opts);
  return tg.editMessage(ctx.chatId, ctx.messageId, view.text, { buttons: view.buttons });
}

async function onMerchantCallback(data, ctx) {
  if (!data.startsWith('mr:')) return false;
  const action = data.slice(3);
  const current = merchantWatcherState();
  if (action === 'activate') {
    saveMerchantWatcherState(applyMerchantWatcherAction(current, action));
    merchantLog('watcher_activated', { source: 'telegram' });
  } else if (action === 'pause') {
    const active = !!merchantActiveJob();
    saveMerchantWatcherState(applyMerchantWatcherAction(current, action, { jobActive: active }));
    merchantLog(active ? 'watcher_pause_pending' : 'watcher_paused', { source: 'telegram' });
  } else if (action === 'refresh') {
    merchantLog('manual_refresh', { source: 'telegram' });
  } else {
    return true;
  }
  await editMerchantStatus(ctx, { forceCost: action === 'refresh' });
  return true;
}

function desiredServiceName(state = {}) {
  if (state.auto) return 'auto';
  if (state.combat) return 'combat';
  if (state.gather) return 'gather';
  if (state.fish) return 'fish';
  return null;
}

async function beginMerchantJob(snapshot) {
  if (merchantPid() || merchantMonitorRunning) return false;
  const potionJob = potionPid() ? readJson(POTION_JOBFILE) : null;
  syncDesiredFromLive();
  const resumeDesired = normalizeDesiredState(potionJob?.resumeDesired || readAutoreviveState());
  const resumeService = desiredServiceName(resumeDesired);
  const shard = await resolveShard();
  const job = {
    cost: snapshot.cost,
    campaign: snapshot.campaign,
    maxTrades: snapshot.maxTrades,
    resumeDesired,
    resumeService,
    shard,
    startedAt: Date.now(),
  };
  try { fs.unlinkSync(MERCHANT_RESULTFILE); } catch {}
  fs.writeFileSync(MERCHANT_JOBFILE, JSON.stringify(job, null, 2));
  saveAutoreviveState({});
  const stopped = stopAllMainBots();
  const stoppedPotion = cancelPotionJob();
  let pid;
  try {
    merchantLog('job_starting', {
      maxTrades: snapshot.maxTrades,
      resources: snapshot.resources,
      stopped: { ...stopped, potion: stoppedPotion },
      resumeService,
    });
    await sleep(300);
    pid = spawnBot('merchant-bot.js', [shard], MPIDFILE);
    merchantLog('worker_spawned', { pid, shard });
  } catch (error) {
    saveAutoreviveState(resumeDesired);
    await ensureDesiredServices({ allowMerchantRestore: true }).catch(() => {});
    try { fs.unlinkSync(MERCHANT_JOBFILE); } catch {}
    merchantLog('job_start_failed', { reason: String(error?.message || error), resumeService });
    throw error;
  }
  await tg.send(
    `🧓 <b>Merchant trade started</b>\nPossible trades: <b>${snapshot.maxTrades}</b>\n` +
    `${resumeService ? `${activityLabel(resumeService, resumeDesired.gather?.kind)} was paused and will resume automatically.` : 'No activity was running.'}`
  ).catch(() => {});
  monitorMerchantJob().catch((error) => merchantLog('monitor_failed', { reason: error.message }));
  return true;
}

async function monitorMerchantJob() {
  if (merchantMonitorRunning) return;
  merchantMonitorRunning = true;
  try {
    while (merchantPid()) await sleep(1000);
    const job = readJson(MERCHANT_JOBFILE);
    if (!job) return;
    const result = readJson(MERCHANT_RESULTFILE) || { ok: false, traded: 0, reason: 'worker stopped without a result' };
    const state = merchantWatcherState();
    if (result.resetAtMs > Date.now()) {
      saveMerchantWatcherState({ cooldownUntil: result.resetAtMs });
      merchantLog('daily_cap_cooldown', { resetAtMs: result.resetAtMs });
    } else if (!result.traded && result.reason && !/no_complete_bundle|merchant_not_trading/.test(result.reason)) {
      const retryAt = Date.now() + 5 * 60 * 1000;
      saveMerchantWatcherState({ cooldownUntil: retryAt });
      merchantLog('worker_retry_backoff', { retryAt, reason: result.reason });
    }
    if (state.pausePending) saveMerchantWatcherState({ enabled: false, pausePending: false });
    saveAutoreviveState(normalizeDesiredState(job.resumeDesired || {}));
    let restoreText = job.resumeService ? `${activityLabel(job.resumeService, job.resumeDesired?.gather?.kind)} restored.` : 'No previous activity was running.';
    try {
      await ensureDesiredServices({ allowMerchantRestore: true, requireMerchantJob: true });
      if (!readJson(MERCHANT_JOBFILE)) {
        merchantLog('activity_restore_cancelled', { source: 'stop_or_update' });
        return;
      }
      merchantLog('activity_restored', { service: job.resumeService || null });
    } catch (error) {
      restoreText = `Activity restore failed: ${String(error.message).slice(0, 100)}`;
      merchantLog('activity_restore_failed', { service: job.resumeService || null, reason: error.message });
    }
    try { fs.unlinkSync(MERCHANT_JOBFILE); } catch {}
    const heading = result.traded > 0 ? '✅ <b>Merchant trade complete</b>' : '⚠️ <b>Merchant trade finished</b>';
    await tg.send(
      `${heading}\nGold received: <b>${Number(result.traded) || 0}</b>` +
      `${result.reason ? `\nReason: <code>${escapeHtml(result.reason)}</code>` : ''}\n\n${escapeHtml(restoreText)}`
    ).catch(() => {});
  } finally {
    merchantMonitorRunning = false;
  }
}

async function performMerchantWatcherPoll() {
  try {
    const state = merchantWatcherState();
    const result = await runMerchantWatcherTick({
      state,
      jobActive: !!merchantPid() || merchantMonitorRunning,
      previousSignature: merchantCampaignSignature,
      fetchSnapshot: () => fetchMerchantSnapshot({ forWatcher: true }),
      startJob: beginMerchantJob,
      log: merchantLog,
    });
    merchantLastPollError = null;
    merchantCampaignSignature = result.signature || merchantCampaignSignature;
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    if (reason !== merchantLastPollError || Date.now() - merchantLastPollErrorAt >= 5 * 60 * 1000) {
      merchantLog('watcher_poll_failed', { reason });
      merchantLastPollError = reason;
      merchantLastPollErrorAt = Date.now();
    }
  }
}

const runMerchantPollWithoutOverlap = createNonOverlappingPoller(performMerchantWatcherPoll);
function pollMerchantWatcher() {
  return runMerchantPollWithoutOverlap();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function potionSessionActive() {
  if (!potionSession) return false;
  if (Date.now() - potionSession.updatedAt <= POTION_SESSION_TTL_MS) return true;
  potionSession = null;
  return false;
}

function potionSummary(session = potionSession) {
  const label = POTION_LABELS[session?.potionType] || session?.potionType || '?';
  const inventory = session?.resources ? `\n\n${formatPotionResources(session.resources)}` : '';
  return `🧪 <b>Potion Purchase</b>\nType: <b>${label}</b>\nQuantity: <b>${session?.quantity || '?'}</b>` +
    `${inventory}\n\n${formatPotionRecipes(session?.catalog)}`;
}

function potionSelectionButtons(session = potionSession) {
  const typeButton = (emoji, label, key) => {
    const type = POTION_TYPES[key];
    const unavailable = session?.catalog?.[type]?.available === false;
    return {
      text: unavailable ? `🚫 ${label}` : `${emoji} ${label}`,
      data: unavailable ? `pt:unavailable:${key}` : `pt:type:${key}`,
    };
  };
  return [
    [
      typeButton('❤️', 'Health', 'health'),
      typeButton('🛡', 'Shield', 'shield'),
    ],
    [
      typeButton('💪', 'Strength', 'strength'),
      typeButton('☠️', 'Poison', 'poison'),
    ],
    [10, 25, 50, 100].map((quantity) => ({ text: String(quantity), data: `pt:qty:${quantity}` })),
    [{ text: '✏️ Custom quantity', data: 'pt:custom' }],
    [{ text: '➡️ Review', data: 'pt:confirm' }, { text: '❌ Cancel', data: 'pt:cancel' }],
  ];
}

async function hPotions() {
  if (merchantPid() || merchantMonitorRunning) return '🧓 A merchant trade is already running. Please wait for its result.';
  if (potionPid()) return '🧪 A potion purchase is already running. Please wait for its result.';
  mkReset();
  const c = await client();
  let me;
  let catalog;
  try {
    [me, catalog] = await Promise.all([c.me(), fetchPotionCatalog(c.apiBase)]);
  } catch (error) {
    console.error('[telegram-bot] potion availability check failed', error.message);
    return '⚠️ Could not verify current potion availability. Run /potions again in a moment.';
  }
  potionSession = {
    potionType: POTION_TYPES.health,
    quantity: 50,
    resources: potionResourceSnapshot(me?.backpack),
    catalog,
    step: 'select',
    updatedAt: Date.now(),
  };
  await tg.send(`${potionSummary()}\n\nChoose a potion type and quantity. Health x50 is selected by default.`, {
    buttons: potionSelectionButtons(),
  });
  return null;
}

async function showPotionSelection(ctx) {
  potionSession.step = 'select';
  potionSession.updatedAt = Date.now();
  return tg.editMessage(ctx.chatId, ctx.messageId, `${potionSummary()}\n\nChoose a potion type and quantity.`, {
    buttons: potionSelectionButtons(),
  });
}

async function beginPotionJob(ctx) {
  if (!potionSessionActive()) {
    await tg.editMessage(ctx.chatId, ctx.messageId, '⚠️ Potion session expired. Run /potions again.');
    return;
  }
  if (potionPid()) {
    await tg.editMessage(ctx.chatId, ctx.messageId, '🧪 A potion purchase is already running.');
    return;
  }
  if (merchantPid() || merchantMonitorRunning) {
    await tg.editMessage(ctx.chatId, ctx.messageId, '🧓 A merchant trade is already running.');
    return;
  }

  syncDesiredFromLive();
  const resumeDesired = normalizeDesiredState(readAutoreviveState());
  const shard = await resolveShard();
  const job = {
    potionType: potionSession.potionType,
    quantity: potionSession.quantity,
    shard,
    resumeDesired,
    startedAt: Date.now(),
  };

  clearDesired('fish', 'gather', 'auto', 'combat');
  const stopped = stopAllMainBots();
  try { fs.unlinkSync(POTION_RESULTFILE); } catch {}
  fs.writeFileSync(POTION_JOBFILE, JSON.stringify(job, null, 2));
  await sleep(250);
  const pid = spawnBot('potion-bot.js', [job.potionType, String(job.quantity), shard], PPIDFILE);
  potionSession = null;
  console.log(`[telegram-bot] potion worker started pid=${pid} type=${job.potionType} qty=${job.quantity}`);
  await tg.editMessage(ctx.chatId, ctx.messageId,
    `🧪 <b>Potion purchase started</b>\n${POTION_LABELS[job.potionType]} x${job.quantity}\nShard: <b>${shard}</b>\n\n` +
    `${Object.values(stopped).some(Boolean) ? 'The current activity was paused and will resume automatically.' : 'No activity was running.'}`);
  monitorPotionJob().catch((error) => console.error('potion monitor err', error.message));
}

async function monitorPotionJob() {
  if (potionMonitorRunning) return;
  potionMonitorRunning = true;
  try {
    while (potionPid()) await sleep(1000);
    const job = readJson(POTION_JOBFILE);
    if (!job) return;
    const result = readJson(POTION_RESULTFILE) || {
      ok: false,
      potionType: job.potionType,
      requested: job.quantity,
      purchased: 0,
      reason: 'worker stopped without a result',
    };

    const requested = Number(result.requested || job.quantity || 0);
    const purchased = Number(result.purchased || 0);
    const label = POTION_LABELS[result.potionType || job.potionType] || result.potionType || job.potionType;
    const reason = result.reason ? `\nReason: <code>${escapeHtml(result.reason)}</code>` : '';
    const returnFailed = /return failed:/i.test(String(result.reason || ''));
    const heading = result.ok && purchased >= requested && !returnFailed ? '✅ <b>Potion purchase complete</b>'
      : result.ok && purchased >= requested && returnFailed ? '⚠️ <b>Purchase complete; return failed</b>'
        : purchased > 0 ? '⚠️ <b>Partial potion purchase</b>'
          : '❌ <b>Potion purchase failed</b>';

    const resumeDesired = normalizeDesiredState(job.resumeDesired || {});
    const hadPreviousActivity = Object.keys(resumeDesired).length > 0;
    saveAutoreviveState(resumeDesired);
    let restoreText = hadPreviousActivity ? 'Previous activity restored.' : 'No previous activity was running.';
    try {
      await ensureDesiredServices();
      console.log(`[telegram-bot] potion job finished; previous activity=${hadPreviousActivity ? 'restored' : 'none'}`);
    } catch (error) {
      console.error('potion activity restore err', error.message);
      restoreText = `Previous activity could not be restored: <code>${escapeHtml(error.message)}</code>`;
    }
    await tg.send(`${heading}\n${escapeHtml(label)}: <b>${purchased}/${requested}</b>${reason}\n\n${restoreText}`).catch(() => {});
    try { fs.unlinkSync(POTION_JOBFILE); } catch {}
  } finally {
    potionMonitorRunning = false;
  }
}

function cancelPotionJob() {
  const pid = stopPidfile(PPIDFILE);
  try { fs.unlinkSync(POTION_JOBFILE); } catch {}
  potionSession = null;
  return pid;
}

async function onPotionCallback(data, ctx) {
  if (!data.startsWith('pt:')) return false;
  const action = data.slice(3);
  if (action === 'cancel') {
    potionSession = null;
    await tg.editMessage(ctx.chatId, ctx.messageId, '❌ Potion purchase cancelled.');
    return true;
  }
  if (!potionSessionActive()) {
    await tg.editMessage(ctx.chatId, ctx.messageId, '⚠️ Potion session expired. Run /potions again.');
    return true;
  }
  if (action.startsWith('unavailable:')) {
    const type = normalizePotionType(action.slice(12));
    const label = POTION_LABELS[type] || 'That potion';
    await tg.editMessage(ctx.chatId, ctx.messageId,
      `${potionSummary()}\n\n⚠️ ${label} is currently unavailable. Choose another potion.`,
      { buttons: potionSelectionButtons() });
    return true;
  }
  if (action.startsWith('type:')) {
    const potionType = normalizePotionType(action.slice(5));
    if (potionType && potionSession.catalog?.[potionType]?.available !== false) potionSession.potionType = potionType;
    await showPotionSelection(ctx);
    return true;
  }
  if (action.startsWith('qty:')) {
    const quantity = parsePotionQuantity(action.slice(4));
    if (quantity) potionSession.quantity = quantity;
    await showPotionSelection(ctx);
    return true;
  }
  if (action === 'custom') {
    potionSession.step = 'custom-quantity';
    potionSession.updatedAt = Date.now();
    await tg.editMessage(ctx.chatId, ctx.messageId,
      `${potionSummary()}\n\nSend a custom quantity between <b>1 and 999</b>.`,
      { buttons: [[{ text: '⬅️ Back', data: 'pt:back' }, { text: '❌ Cancel', data: 'pt:cancel' }]] });
    return true;
  }
  if (action === 'back') {
    await showPotionSelection(ctx);
    return true;
  }
  if (action === 'confirm') {
    potionSession.step = 'confirm';
    potionSession.updatedAt = Date.now();
    await tg.editMessage(ctx.chatId, ctx.messageId,
      `${potionSummary()}\n\nThe current activity will pause, the character will walk to the shop, and the activity will resume afterward.`,
      { buttons: [[{ text: '✅ Buy now', data: 'pt:execute' }], [{ text: '⬅️ Back', data: 'pt:back' }, { text: '❌ Cancel', data: 'pt:cancel' }]] });
    return true;
  }
  if (action === 'execute') {
    await beginPotionJob(ctx);
    return true;
  }
  return true;
}

async function onPotionText(text) {
  if (!potionSessionActive() || potionSession.step !== 'custom-quantity') return false;
  const quantity = parsePotionQuantity(text);
  if (!quantity) {
    await tg.send('⚠️ Quantity must be a whole number between 1 and 999.');
    return true;
  }
  potionSession.quantity = quantity;
  potionSession.step = 'select';
  potionSession.updatedAt = Date.now();
  await tg.send(`${potionSummary()}\n\nCustom quantity saved. Review or change the selection.`, {
    buttons: potionSelectionButtons(),
  });
  return true;
}

const MARKET_ITEMS = [
  ['fish', '🎣 fish'],
  ['cooked_fish_meat', '🍳 cooked'],
  ['wood', '🪵 wood'],
  ['stone', '🪨 stone'],
  ['coal', '⬛ coal'],
  ['metal', '🔩 metal'],
  ['gold', '🪙 gold'],
];
const ITEM_LABEL = {
  ...Object.fromEntries(MARKET_ITEMS.map(([k, v]) => [k, v])),
  potion_health: '🧪 health potion',
  potion_shield: '🧪 shield potion',
  potion_strength: '🧪 strength potion',
  potion_poison: '🧪 poison potion',
};
const MARKET_CATEGORY_LABEL = Object.fromEntries(MARKET_CATEGORIES.map(({ id, label }) => [id, label]));

let mkSession = null;
function mkReset() { mkSession = null; }
function marketSellSafetyWarning() {
  if (!botPid() && !gatherPid() && !combatPid() && !pidOf(OPIDFILE)) return '';
  return '<i>Warning: a bot is currently running. Selling while automation is active may fail if inventory slots change. For the safest sell flow, use /stop first.</i>\n\n';
}
function fmtMarketNum(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  return n.toFixed(digits).replace(/\.?0+$/, '');
}
function roundMarketTotal(v) {
  return Math.max(1, Math.round(Number(v) || 0));
}

async function hMarket() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  potionSession = null;
  const c = await client();
  const lines = ['🛍 <b>Marketplace — Live Prices</b>', ''];
  for (const [itemType, label] of MARKET_ITEMS) {
    if (itemType === 'gold') continue;
    try {
      const r = await c.marketplaceStats(itemType);
      const last = Array.isArray(r?.samples) && r.samples.length ? r.samples[r.samples.length - 1] : null;
      lines.push(`${label} — avg30d <b>${fmtMarketNum(r?.avg30d)}g/unit</b> | last ${fmtMarketNum(last?.avgUnitPrice)}g/unit | sales ${last?.sales ?? 0}`);
    } catch (e) {
      lines.push(`${label} — err ${e.message.slice(0, 30)}`);
    }
  }
  let kins = '?';
  try { const t = await c.tokenBlimpStats(); kins = `$${Number(t.priceUsd).toFixed(6)}`; } catch {}
  lines.push('', `🪙 $KINS: <b>${kins}</b>`, '', '<i>Choose an action — Sell (gold/$KINS) or Buy from live listings.</i>');
  mkReset();
  await tg.send(lines.join('\n'), {
    buttons: [[{ text: '💰 SELL', data: 'mk:sell' }, { text: '🛒 BUY', data: 'mk:buy' }], [{ text: '📦 MY LISTINGS', data: 'mk:mine' }]],
  });
  return null;
}

function formatListingPrice(x) {
  if (x.currency === 'token' || x.currency === 'kins') return `$${x.priceUsd ?? '?'} total ($KINS)`;
  return `${x.priceGold ?? '?'}g total`;
}

async function mkShowInventory(ctx) {
  const c = await client();
  const me = await c.me(); const bp = me.backpack || {};
  const rows = [];
  // Marketplace sell only accepts items occupying inventory slots, not bulk resources.
  (bp.invSlots || []).forEach((sl, i) => {
    if (sl && sl.t) {
      const lbl = ITEM_LABEL[sl.t] || sl.t;
      rows.push({ text: `${lbl} (${sl.n || 1})`, data: `mk:itm:${i}` });
    }
  });
  if (!rows.length) {
    await tg.editMessage(ctx.chatId, ctx.messageId, '🎒 There are no inventory-slot items available to sell.\n\n<i>Bulk resources (stone/wood/fish) cannot be listed directly on the Marketplace yet — they must exist as slot items first.</i>', { buttons: [[{ text: '⬅️ Back', data: 'mk:back' }]] });
    return;
  }
  const grid = [];
  for (let i = 0; i < rows.length; i += 2) grid.push(rows.slice(i, i + 2));
  grid.push([{ text: '⬅️ Back', data: 'mk:back' }]);
  mkSession = { mode: 'sell', step: 'pick-item' };
  await tg.editMessage(ctx.chatId, ctx.messageId, `${marketSellSafetyWarning()}💰 <b>SELL</b> — choose an item:`, { buttons: grid });
}
async function mkPickCurrency(slotIdx, ctx) {
  const c = await client();
  const me = await c.me(); const sl = (me.backpack?.invSlots || [])[Number(slotIdx)];
  if (!sl || !sl.t) { await tg.editMessage(ctx.chatId, ctx.messageId, '⚠️ Slot is empty, please choose again.', { buttons: [[{ text: '⬅️ Back', data: 'mk:sell' }]] }); return; }
  mkSession = { mode: 'sell', slotIndex: Number(slotIdx), item: sl.t, have: Number(sl.n || 1), step: 'pick-currency' };
  await tg.editMessage(ctx.chatId, ctx.messageId,
    `${marketSellSafetyWarning()}💰 <b>SELL ${ITEM_LABEL[sl.t] || sl.t}</b> (you have ${sl.n || 1})\nWhich currency do you want to use?`,
    { buttons: [[{ text: '🪙 Gold', data: 'mk:cur:gold' }, { text: '🪙 $KINS', data: 'mk:cur:token' }], [{ text: '⬅️ Back', data: 'mk:sell' }]] });
}
async function mkAskQtyPrice(currency, ctx) {
  if (!mkSession || !mkSession.item) { await tg.send('⚠️ Session expired, please run /market again.'); return; }
  mkSession = { mode: 'sell', item: mkSession.item, slotIndex: mkSession.slotIndex, have: mkSession.have, currency, step: 'await-input' };
  const unit = currency === 'token' ? 'USD (total listing)' : 'gold (total listing, whole number)';
  let hint = '';
  if (currency === 'gold') {
    try {
      const c = await client();
      const st = await c.marketplaceStats(mkSession.item);
      const unitAvg = Number(st?.avg30d);
      if (Number.isFinite(unitAvg) && unitAvg > 0) {
        const haveQty = Number(mkSession.have || 1);
        const fast = roundMarketTotal(unitAvg * haveQty * 0.75);
        const normal = roundMarketTotal(unitAvg * haveQty);
        const premium = roundMarketTotal(unitAvg * haveQty * 1.25);
        hint =
          `\n\n📈 Market avg right now: <b>${fmtMarketNum(unitAvg)}g/unit</b>` +
          `\nFor your current stack <b>${haveQty}</b>:` +
          `\n• fast sell: <code>${haveQty} ${fast}</code>` +
          `\n• normal: <code>${haveQty} ${normal}</code>` +
          `\n• premium: <code>${haveQty} ${premium}</code>` +
          `\n\nYou can also type any custom total you want: <code>qty price</code>.`;
      }
    } catch {}
  }
  await tg.editMessage(ctx.chatId, ctx.messageId,
    `${marketSellSafetyWarning()}💰 <b>SELL ${ITEM_LABEL[mkSession.item] || mkSession.item}</b> — ${currency === 'token' ? '$KINS' : 'Gold'}\n\n` +
    `Type: <code>qty price</code>\nExample: <code>200 2</code>\n\n• qty = quantity\n• price = ${unit}${hint}`,
    { buttons: [[{ text: '❌ Cancel', data: 'mk:back' }]] });
}

async function mkSubmitListing(text) {
  const m = text.trim().split(/\s+/);
  const qty = parseInt(m[0], 10); const price = Number(m[1]);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
    return '⚠️ Invalid format. Type: <code>qty price</code> (example <code>1 25</code>).';
  }
  const { item, currency, slotIndex } = mkSession;
  const c = await client();
  const me = await c.me(); const sl = (me.backpack?.invSlots || [])[slotIndex];
  if (!sl || sl.t !== item) { mkReset(); return '⚠️ The item in that slot changed. Please run /market again.'; }
  const have = sl.n || 1;
  if (have < qty) { mkReset(); return `⚠️ Not enough stock: you have ${have} ${ITEM_LABEL[item] || item}, but tried to sell ${qty}.`; }
  if (currency === 'gold' && !Number.isInteger(price)) {
    return '⚠️ Gold listing must use a whole-number total price. Example: <code>200 2</code> means 200 items for total 2 gold.';
  }
  const payload = { itemType: item, slotKind: 'inv', slotIndex, quantity: qty, currency };
  if (currency === 'token') payload.priceUsd = price; else payload.priceGold = price;
  try {
    const r = await c.marketplaceSell(payload);
    mkReset();
    if (r && r.ok === false) return `❌ Listing rejected: ${JSON.stringify(r).slice(0, 120)}`;
    const curLabel = currency === 'token' ? `$${price} total (≈$KINS)` : `${price}g total`;
    return `✅ <b>Listed!</b>\n${ITEM_LABEL[item] || item} x${qty} @ ${curLabel}\n\n<i>${currency === 'token' ? '$KINS goes to your wallet when there is a buyer (95% you / 5% treasury).' : 'Gold is paid when there is a buyer.'}</i>`;
  } catch (e) {
    mkReset();
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('seller_skill_too_low')) return '🔒 Your skill level is not high enough to sell this item on the Marketplace yet.';
    if (msg.includes('bad_slot')) return '⚠️ Bulk resources cannot be listed directly — only inventory-slot items can be sold.';
    return `❌ Listing failed: ${(e.message || '').slice(0, 120)}`;
  }
}
async function mkShowBuy(ctx) {
  mkSession = { mode: 'buy', step: 'pick-category' };
  const categoryButtons = MARKET_CATEGORIES.map(({ id, label }) => ({ text: label, data: `mk:cat:${id}` }));
  const grid = [];
  for (let i = 0; i < categoryButtons.length; i += 2) grid.push(categoryButtons.slice(i, i + 2));
  grid.push([{ text: '⬅️ Back', data: 'mk:back' }]);
  await tg.editMessage(ctx.chatId, ctx.messageId, '🛒 <b>BUY</b> — choose a category:\n\n<i>Listings are ordered by the cheapest unit price returned by the Marketplace.</i>', { buttons: grid });
}

async function mkShowBuyCategory(category, ctx) {
  if (!MARKET_CATEGORY_LABEL[category]) return mkShowBuy(ctx);
  const c = await client();
  let response;
  try {
    response = await c.marketplaceListings({ sort: 'cheap', currency: 'all', category, limit: 20, offset: 0 });
  } catch (e) {
    await tg.editMessage(ctx.chatId, ctx.messageId, `⚠️ Failed to load listings: ${e.message.slice(0, 50)}`, { buttons: [[{ text: '⬅️ Categories', data: 'mk:buy' }]] });
    return;
  }
  const listings = response.listings || response.items || response.data || [];
  if (!listings.length) {
    await tg.editMessage(ctx.chatId, ctx.messageId, `🛒 There are no active listings in ${MARKET_CATEGORY_LABEL[category]}.`, { buttons: [[{ text: '⬅️ Categories', data: 'mk:buy' }]] });
    return;
  }
  mkSession = { mode: 'buy', step: 'listings', category };
  const total = Number.isFinite(Number(response.total)) ? Number(response.total) : listings.length;
  const lines = [`🛒 <b>BUY — ${MARKET_CATEGORY_LABEL[category]}</b>`, `<i>Cheapest price per unit first • showing ${Math.min(20, listings.length)} of ${total}</i>`, ''];
  for (const x of listings.slice(0, 20)) {
    const it = x.itemType || x.item; const lbl = ITEM_LABEL[it] || it;
    lines.push(`${lbl} x${x.quantity} — <b>${formatListingUnitPrice(x)}</b> • ${formatListingPrice(x)} • ${x.sellerName || '?'}`);
  }
  lines.push('', '<i>⚠️ Buying a $KINS listing requires an on-chain wallet signature — complete that in the web game. Gold listings are purchased in-game.</i>');
  await tg.editMessage(ctx.chatId, ctx.messageId, lines.join('\n'), { buttons: [[{ text: '⬅️ Categories', data: 'mk:buy' }], [{ text: '📦 My Listings', data: 'mk:mine' }]] });
}

async function mkShowMine(ctx) {
  const c = await client();
  let arr = [];
  try {
    const Lst = await c.marketplaceListings({ limit: 20, mine: true });
    arr = Lst.listings || Lst.items || Lst.data || [];
  } catch (e) {
    await tg.editMessage(ctx.chatId, ctx.messageId, `⚠️ Failed to load your listings: ${e.message.slice(0, 50)}`, { buttons: [[{ text: '⬅️ Back', data: 'mk:back' }]] });
    return;
  }
  if (!arr.length) {
    await tg.editMessage(ctx.chatId, ctx.messageId, '📦 You have no active listings right now.', { buttons: [[{ text: '⬅️ Back', data: 'mk:back' }], [{ text: '💰 Sell', data: 'mk:sell' }]] });
    return;
  }
  const lines = ['📦 <b>My Listings</b>', ''];
  const buttons = [];
  for (const x of arr.slice(0, 10)) {
    const it = x.itemType || x.item; const lbl = ITEM_LABEL[it] || it;
    lines.push(`#${x.id} • ${lbl} x${x.quantity} — <b>${formatListingPrice(x)}</b>`);
    buttons.push([{ text: `❌ Cancel #${x.id}`, data: `mk:cancel:${x.id}` }]);
  }
  buttons.push([{ text: '⬅️ Back', data: 'mk:back' }]);
  await tg.editMessage(ctx.chatId, ctx.messageId, lines.join('\n'), { buttons });
}

async function mkCancelListing(id, ctx) {
  const c = await client();
  try {
    const r = await c.marketplaceCancel(Number(id));
    if (r && r.ok === false) {
      await tg.editMessage(ctx.chatId, ctx.messageId, `❌ Cancel rejected: ${JSON.stringify(r).slice(0, 120)}`, { buttons: [[{ text: '⬅️ Back', data: 'mk:mine' }]] });
      return;
    }
    await tg.editMessage(ctx.chatId, ctx.messageId, `✅ Listing #${id} cancelled.`, { buttons: [[{ text: '📦 Refresh My Listings', data: 'mk:mine' }], [{ text: '⬅️ Back', data: 'mk:back' }]] });
  } catch (e) {
    await tg.editMessage(ctx.chatId, ctx.messageId, `❌ Cancel failed: ${(e.message || '').slice(0, 120)}`, { buttons: [[{ text: '⬅️ Back', data: 'mk:mine' }]] });
  }
}

async function onMarketCallback(data, ctx) {
  if (!data.startsWith('mk:')) return;
  const rest = data.slice(3);
  if (rest === 'sell') return mkShowInventory(ctx);
  if (rest === 'buy') return mkShowBuy(ctx);
  if (rest === 'mine') return mkShowMine(ctx);
  if (rest === 'back') {
    mkReset();
    return tg.editMessage(ctx.chatId, ctx.messageId, '🛍 <b>Marketplace</b> — choose an action:', { buttons: [[{ text: '💰 SELL', data: 'mk:sell' }, { text: '🛒 BUY', data: 'mk:buy' }], [{ text: '📦 MY LISTINGS', data: 'mk:mine' }]] });
  }
  if (rest.startsWith('cat:')) return mkShowBuyCategory(rest.slice(4), ctx);
  if (rest.startsWith('cancel:')) return mkCancelListing(rest.slice(7), ctx);
  if (rest.startsWith('itm:')) return mkPickCurrency(rest.slice(4), ctx);
  if (rest.startsWith('cur:')) return mkAskQtyPrice(rest.slice(4), ctx);
}

async function onMarketText(text) {
  if (mkSession && mkSession.step === 'await-input') {
    const reply = await mkSubmitListing(text);
    if (reply) await tg.send(reply);
    return true;
  }
  return false;
}

async function onTelegramCallback(data, ctx) {
  if (data.startsWith('pt:')) return onPotionCallback(data, ctx);
  if (data.startsWith('mr:')) return onMerchantCallback(data, ctx);
  return onMarketCallback(data, ctx);
}

async function onTelegramText(text, ctx) {
  if (await onPotionText(text, ctx)) return true;
  return onMarketText(text, ctx);
}
async function hQuest() {
  const c = await client(); const q = await c.dailyQuestProgress().catch(() => ({}));
  const dq = q?.dailyQuest || {}; const cfg = q?.dailyQuestConfig || {};
  if (!(cfg.quests || []).length) return `📋 <b>Daily Quest</b> (${dq.day || '?'})\n(no quests available today)`;
  const prog = { ...(dq.prog || {}) };
  const claimed = { ...(dq.claimed || {}) };
  const claimedNow = [];
  for (const quest of (cfg.quests || [])) {
    const pr = prog[quest.id] || 0;
    if (pr >= quest.target && !claimed[quest.id]) {
      try {
        const r = await c.dailyQuestClaim(quest.id);
        if (!r?.error) {
          claimed[quest.id] = true;
          claimedNow.push(quest.label);
        }
      } catch {}
    }
  }
  const lines = (cfg.quests || []).map((quest) => {
    const pr = prog[quest.id] || 0; const cl = claimed[quest.id];
    return `${cl ? '✅' : pr >= quest.target ? '🎁' : '▫️'} ${quest.label} — ${pr}/${quest.target} (${quest.rewardXpSpreadTotal}XP)`;
  });
  const head = `📋 <b>Daily Quest</b> (${dq.day})`;
  const auto = claimedNow.length ? `\n🎁 Auto-claimed: ${claimedNow.join(', ')}` : '';
  return head + auto + '\n' + lines.join('\n');
}
async function hVersion() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  const current = await fetchGameVersion();
  const prev = readVersionState();
  const changed = !!(prev.sha && current.sha && prev.sha !== current.sha);
  saveVersionState({
    sha: current.sha,
    previousSha: changed ? prev.sha : (prev.previousSha || null),
    lastChangedAt: changed ? Date.now() : (prev.lastChangedAt || null),
    notifiedSha: changed ? current.sha : (prev.notifiedSha || null),
    verifiedSha: changed ? null : (prev.verifiedSha || null),
    verifiedAt: changed ? null : (prev.verifiedAt || null),
    verifiedNotes: changed ? [] : (prev.verifiedNotes || []),
  });
  const next = readVersionState();
  const active = [
    pidOf(OPIDFILE) ? 'auto' : null,
    botPid() ? 'fish' : null,
    gatherPid() ? 'gather' : null,
    combatPid() ? 'combat' : null,
    potionPid() ? 'potions' : null,
  ].filter(Boolean);
  const changedAt = next.lastChangedAt ? new Date(next.lastChangedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-';
  const compat = versionVerificationSummary(next, current.sha);
  return `🧩 <b>Game Version</b>\ncurrent: ${current.sha || '?'}\nprevious: ${next.previousSha || next.sha || current.sha || '?'}\nlast change: ${changedAt}\n${compat}\nwatch: auto-detect ON (${Math.round(VERSION_POLL_MS / 60000)}m)\nautomation: ${active.length ? active.join(', ') : 'idle'}`;
}
async function hDiag() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  const c = await client();
  const me = await c.me().catch(() => ({}));
  const viewer = await c.viewerLevel().catch(() => ({}));
  const servers = await c.servers().catch(() => ({}));
  const player = me?.player || {};
  const tutorialStep = me?.tutorialStep ?? '?';
  const queueable = (servers?.servers || [])
    .filter((s) => !s.minLevel || s.minLevel <= 1)
    .sort((a, b) => (a.queueLength ?? 999) - (b.queueLength ?? 999))
    .slice(0, 3)
    .map((s) => `${s.name}: q${s.queueLength}${s.full ? '' : ' open'}`)
    .join(' | ') || 'n/a';
  const lastErr = Object.values(getErrors())
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))[0];
  const desired = normalizeDesiredState(readAutoreviveState());
  const desiredMain = desired.auto ? '🧠 auto' : desired.combat ? '⚔️ combat' : desired.gather ? `🪓 gather${desired.gather?.kind === 'rock' ? ' rock' : desired.gather?.kind === 'tree' ? ' tree' : ''}` : desired.fish ? '🎣 fish' : 'none';
  const procLine = [
    `tg ${procAgeMin(TGPIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(TGPIDFILE))}` : '🔴 off'}`,
    `auto ${procAgeMin(OPIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(OPIDFILE))}` : '🔴 off'}`,
    `fish ${procAgeMin(PIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(PIDFILE))}` : '🔴 off'}`,
    `gather ${procAgeMin(GPIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(GPIDFILE))}` : '🔴 off'}`,
    `combat ${procAgeMin(CPIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(CPIDFILE))}` : '🔴 off'}`,
    `potions ${procAgeMin(PPIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(PPIDFILE))}` : '🔴 off'}`,
  ].join(' | ');
  const lines = [
    '🩺 <b>Diag</b>',
    `👤 ${player.display_name || player.username || '?'} • id ${player.id || '?'}`,
    `🧭 shard ${(await resolveShard().catch(() => null)) || config.shard || 's4'} • tutorial ${tutorialStep} • avg ${viewer?.avgLevel ?? '?'}`,
    `🎒 inv ${(me?.backpack?.invSlots || []).filter(Boolean).length}/24 • gold ${me?.backpack?.gold || 0}`,
    '',
    '🤖 <b>Process</b>',
    procLine,
    `♻️ desired: ${desiredMain}`,
    `🚪 queue: ${queueable}`,
  ];
  const vs = readVersionState();
  if (vs.sha) lines.push(`🧩 ver: ${String(vs.sha).slice(0, 8)}`);
  lines.push(`✅ ${versionVerificationSummary(vs, vs.sha)}`);
  const review = currentVersionReviewStatus(vs, vs.sha);
  if (review) lines.push(`🧪 ${review}`);
  if (lastErr) lines.push(`⚠️ last err: ${lastErr.code} @ ${lastErr.context} (${lastErr.count}x)`);
  return lines.join('\n');
}
async function hStartFish() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  if (gatherPid() || combatPid() || pidOf(OPIDFILE) || potionPid() || merchantPid()) return '⚠️ Another bot is already running — use /stop first (1 account = 1 activity).';
  if (botPid()) return '🎣 Fishing bot is already running.';
  replaceMainDesired('fish', {});
  const shard = await resolveShard();
  const pid = spawnBot('bot-headless.js', [shard], PIDFILE);
  return `🎣 Fishing bot STARTED (pid ${pid}) on shard <b>${shard}</b> (lowest queue). Queue time is about ~10 minutes, then it will fish and cook automatically. Check /status.`;
}
async function hStartGather(args) {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  if (botPid() || combatPid() || pidOf(OPIDFILE) || potionPid() || merchantPid()) return '⚠️ Another bot is already running — use /stop first (1 account = 1 activity).';
  const kind = (args[0] === 'rock' || args[0] === 'stone' || args[0] === 'coal' || args[0] === 'mine') ? 'rock' : 'tree';
  const lbl = kind === 'rock' ? '⛏ mining stone/coal/metal' : '🪓 woodcutting';
  const running = gatherPid(); const cur = readJson(GPIDFILE);
  if (running && cur?.kind === kind) return `${lbl} is already running.`;
  if (running) { try { process.kill(running, 'SIGKILL'); } catch {} try { fs.unlinkSync(GPIDFILE); } catch {} } // switch kind
  replaceMainDesired('gather', { kind });
  const shard = await resolveShard();
  const pid = spawnBot('gather-bot.js', [kind, shard], GPIDFILE);
  fs.writeFileSync(GPIDFILE, JSON.stringify({ pid, kind, started: Date.now() })); // save kind
  return `${lbl} STARTED (pid ${pid}) on shard <b>${shard}</b> (lowest queue)${running ? ` [switched from ${cur?.kind || '?'}]` : ''}. Queue time is about ~10 minutes. Check /status.`;
}
async function hAuto() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  if (botPid() || gatherPid() || combatPid() || potionPid() || merchantPid()) return '⚠️ Another bot is already running — use /stop before starting the orchestrator.';
  if (pidOf(OPIDFILE)) return '🧠 Orchestrator is already running.';
  replaceMainDesired('auto', {});
  const pid = spawnBot('orchestrator.js', [], OPIDFILE);
  return `🧠 Orchestrator STARTED (pid ${pid}) — it will choose fishing/gather automatically based on goals. Use /stop to turn it off.`;
}
async function hStartCombat() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  if (botPid() || gatherPid() || pidOf(OPIDFILE) || potionPid() || merchantPid()) return '⚠️ Another bot is already running — use /stop first (1 account = 1 activity).';
  if (combatPid()) return '⚔️ Combat bot is already running.';
  replaceMainDesired('combat', {});
  const shard = await resolveShard();
  const pid = spawnBot('combat-bot.js', [shard], CPIDFILE);
  return `⚔️ Combat bot STARTED (pid ${pid}) on shard <b>${shard}</b> (lowest queue).\n🏦 It will bank first for safety, then enter the Wilderness and hunt zombies.\n🛡️ Auto-potion and retreat are enabled when HP gets critical. Queue time is about ~10 minutes. Check /status.\n\n<i>⚠️ Wilderness is PvP risk. Banked loot stays safe even if you die.</i>`;
}
function hStop() {
  let msg = [];
  clearDesired('fish', 'gather', 'auto', 'combat');
  for (const [name, pf] of [['Orchestrator', OPIDFILE], ['Fishing', PIDFILE], ['Gather', GPIDFILE], ['Combat', CPIDFILE]]) {
    const pid = stopPidfile(pf);
    if (pid) msg.push(`🛑 ${name} STOP (pid ${pid})`);
  }
  const potion = cancelPotionJob();
  if (potion) msg.push(`🛑 Potion worker STOP (pid ${potion})`);
  const merchant = stopPidfile(MPIDFILE);
  if (merchant) msg.push(`🛑 Merchant worker STOP (pid ${merchant})`);
  if (merchant || merchantWatcherState().enabled !== false) {
    saveMerchantWatcherState({ enabled: false, pausePending: false });
    try { fs.unlinkSync(MERCHANT_JOBFILE); } catch {}
    merchantLog('watcher_paused', { source: 'stop_command' });
    msg.push('🛑 Merchant watcher PAUSED');
  }
  return msg.length ? msg.join('\n') : '🔴 All bots are already OFF.';
}
function hHelp() {
  return `🤖 <b>Kintara Bot — Commands</b>\n` +
    `/status — bot status & inventory\n/skills — skill levels, XP, avg level\n/balance — gold/$KINS/resources\n/market — marketplace prices & actions\n/potions — buy potions from the alchemist\n/merchant — automatic Traveling Merchant watcher\n/version — current game version\n/quest — daily quests\n/spinner — 🎡 free spin wheel (12h)\n/diag — auth, queue, tutorial, process\n` +
    `/fishing — fishing + cooking\n/gather — woodcutting 🪓\n/mine — mining stone/coal/metal ⛏\n/combat — hunt Wilderness zombies ⚔️\n/auto — automatic orchestrator (smart activity switching) 🧠\n/stop — stop all bots\n/help — command list\n\n` +
    `<i>1 account = 1 activity (safer against anti-cheat). Combat uses bank-first + auto-survival.</i>`;
}

async function hServers() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  const c = await client();
  let r;
  try { r = await c.servers(); } catch (e) { return `\u26a0\ufe0f Failed to fetch servers: ${e.message.slice(0, 60)}`; }
  const list = (r.servers || []).filter((x) => x && x.id != null);
  if (!list.length) return '\u26a0\ufe0f No server data.';
  list.sort((a, b) => Number(a.queueLength || 0) - Number(b.queueLength || 0));
  const lines = ['\ud83c\udf10 <b>Servers \u2014 Live Queue</b>', ''];
  const levelGated = process.env.KINTARA_ALLOW_LOW_SERVERS === '1' ? new Set() : new Set([1, 2, 3]);
  for (const sv of list) {
    const locked = levelGated.has(Number(sv.id));
    const mark = locked ? '🔒' : (sv.full ? '\ud83d\udd34' : '\ud83d\udfe2');
    const tag = locked ? ' (lvl 20+)' : (sv.full ? ' (full)' : '');
    lines.push(`${mark} s${sv.id} ${sv.name || ''} — queue <b>${sv.queueLength ?? '?'}</b>${tag}`);
  }
  const best = await pickBestShard(true);
  lines.push('', `✅ Auto-pick on start: <b>${best || '?'}</b> (lowest joinable queue)`, '<i>🔒 s1–s3 need level 20+ — auto-skipped.</i>');
  return lines.join('\n');
}

const commands = {
  start: () => hHelp(), help: () => hHelp(),
  status: hStatus, skills: hSkills, balance: hBalance, market: hMarket, potions: hPotions, merchant: hMerchant, version: hVersion,
  quest: hQuest, diag: hDiag, fishing: hStartFish, fish: hStartFish, stop: hStop,
  server: hServers, servers: hServers,
  spinner: hSpinner, spin: hSpinner,
  gather: hStartGather, chop: hStartGather, mine: () => hStartGather(['rock']),
  auto: hAuto, combat: hStartCombat,
  sell: () => '💰 Selling becomes available after the tutorial is completed.',
};

// Set Telegram menu commands to only the currently supported commands, removing stale ones
const MENU = [
  { command: 'fishing', description: '🎣 Fishing + cooking' },
  { command: 'gather', description: '🪓 Chop wood' },
  { command: 'mine', description: '⛏ Mining stone/coal/metal' },
  { command: 'combat', description: '⚔️ Hunt zombie Wilderness' },
  { command: 'auto', description: '🧠 Auto activity orchestration' },
  { command: 'stop', description: '⏹️ Stop all bots' },
  { command: 'status', description: '📊 Bot status + inventory' },
  { command: 'diag', description: '🩺 Auth, queue, tutorial' },
  { command: 'server', description: '🌐 Live server queues' },
  { command: 'market', description: '🛒 Marketplace prices' },
  { command: 'potions', description: '🧪 Buy alchemist potions' },
  { command: 'merchant', description: '🧓 Gold merchant watcher' },
  { command: 'version', description: '🧩 Game version watch' },
  { command: 'skills', description: '📈 Skill levels & XP' },
  { command: 'balance', description: '💰 Gold/$KINS/resource' },
  { command: 'quest', description: '📋 Daily quest' },
  { command: 'spinner', description: '🎡 Free spin wheel (12h)' },
  { command: 'help', description: '❓ Command list' },
];
async function syncMenu() {
  try {
    const { config } = require('../config');
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/setMyCommands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: MENU }),
    });
    console.log('[telegram-bot] menu commands synced (' + MENU.length + ' command)');
  } catch (e) { console.error('syncMenu err', e.message); }
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'control'), { recursive: true });
  const initialMerchantState = merchantWatcherState();
  if (!fs.existsSync(MERCHANT_WATCHER_STATEFILE)) writeMerchantWatcherState(MERCHANT_WATCHER_STATEFILE, initialMerchantState);
  merchantLog('watcher_started', { enabled: initialMerchantState.enabled !== false, intervalMs: MERCHANT_POLL_MS });
  fs.writeFileSync(TGPIDFILE, JSON.stringify({ pid: process.pid, started: Date.now() }));
  process.on('exit', () => {
    try { merchantLog('watcher_stopped'); } catch {}
    try { fs.unlinkSync(TGPIDFILE); } catch {}
  });
  process.on('SIGINT', () => { console.log('[telegram-bot] SIGINT received, exiting'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('[telegram-bot] SIGTERM received, exiting'); process.exit(0); });
  process.on('SIGHUP', () => { console.log('[telegram-bot] SIGHUP received, exiting'); process.exit(0); });
  process.on('uncaughtException', (err) => { console.error('[telegram-bot] uncaughtException', err?.stack || err?.message || err); process.exit(1); });
  process.on('unhandledRejection', (err) => { console.error('[telegram-bot] unhandledRejection', err?.stack || err?.message || err); process.exit(1); });
  syncDesiredFromLive();
  await syncMenu();
  await maybeNotifyVersionChange();
  if (process.env.KINTARA_VERIFY_CURRENT_SHA === '1') {
    const current = await fetchGameVersion();
    if (current.sha) markVersionVerified(current.sha, ['rest', 'presence', 'gather']);
  }
  if (AUTO_VERSION_REVIEW) {
    const state = readVersionState();
    if (state.sha && state.verifiedSha !== state.sha) runAutoVersionReview(state.sha);
  }
  const recoveringMerchant = merchantPid() || readJson(MERCHANT_JOBFILE);
  if (recoveringMerchant) monitorMerchantJob().catch((error) => merchantLog('monitor_recovery_failed', { reason: error.message }));
  else await ensureDesiredServices();
  if (potionPid() || readJson(POTION_JOBFILE)) {
    monitorPotionJob().catch((error) => console.error('potion monitor recovery err', error.message));
  }
  await tg.send('🤖 <b>Kintara Bot online!</b> Type /help to see the command list.').catch(() => {});
  console.log('[telegram-bot] polling...');
  let nextVersionPollAt = Date.now() + VERSION_POLL_MS;
  let nextKeepaliveAt = Date.now() + KEEPALIVE_POLL_MS;
  let nextMerchantPollAt = Date.now();
  for (;;) {
    try { await tg.pollCommands(commands, { onCallback: onTelegramCallback, onText: onTelegramText }); } catch (e) { console.error('poll err', e.message); }
    if (Date.now() >= nextVersionPollAt) {
      await maybeNotifyVersionChange();
      nextVersionPollAt = Date.now() + VERSION_POLL_MS;
    }
    if (Date.now() >= nextKeepaliveAt) {
      try { await ensureDesiredServices(); } catch (e) { console.error('keepalive err', e.message); }
      nextKeepaliveAt = Date.now() + KEEPALIVE_POLL_MS;
    }
    if (Date.now() >= nextMerchantPollAt) {
      await pollMerchantWatcher();
      nextMerchantPollAt = Date.now() + MERCHANT_POLL_MS;
    }
    await sleep(150);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}

module.exports = { main, potionSelectionButtons, onMerchantCallback, merchantStatusMessage, pollMerchantWatcher };
