#!/usr/bin/env node
// ============ TELEGRAM CONTROL BOT — controls and reports headless bot status ============
// Control the Kintara bot via Telegram: status, skills, balance, quests, start/stop fishing.
// Uses lib/telegram (long polling). Token+chatId come from .env; chat ID is auto-captured
// when the first message is sent to the bot.
//
// Usage: node tools/telegram-bot.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const tg = require('../lib/telegram');
const { KintaraClient } = require('../lib/kintaraClient');
const { login } = require('../lib/walletAuth');
const { config } = require('../config');
const { pickPlayerName, pickPlayerId, playerLabel, htmlEscape } = require('../lib/playerIdentity');
const { installGracefulShutdown } = require('../lib/shutdown');
const { stopPidFile } = require('../lib/processControl');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const PIDFILE = path.join(OUT, 'control', 'fishbot.pid');
const GPIDFILE = path.join(OUT, 'control', 'gatherbot.pid');
const OPIDFILE = path.join(OUT, 'control', 'orch.pid');
const CPIDFILE = path.join(OUT, 'control', 'combatbot.pid');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAILY_SPINNER_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MANAGED_BOTS = [
  ['Orchestrator', OPIDFILE],
  ['Fishing', PIDFILE],
  ['Gather', GPIDFILE],
  ['Combat', CPIDFILE],
];

let cli = null, lastAuth = 0, myPid = null, myName = '', spinnerBusy = false;
const isShuttingDown = installGracefulShutdown({
  log: console.log,
  cleanup: async (signal) => {
    console.log(`[telegram-bot] shutdown requested (${signal}) — stopping managed bots`);
    for (const [, pidfile] of MANAGED_BOTS) stopPidFile(pidfile, { signal: 'SIGTERM', forceAfterMs: 0 });
    await sleep(1500);
  },
});
async function client() {
  if (!cli || Date.now() - lastAuth > 1500000) {
    const a = await login();
    cli = new KintaraClient({ cookie: a.cookie });
    myPid = pickPlayerId(a.player) || myPid;
    myName = pickPlayerName(a.player) || myName;
    const me = await cli.me().catch(() => null);
    myPid = pickPlayerId(me?.player, me, a.player) || myPid;
    myName = pickPlayerName(me?.player, me, a.player) || myName;
    lastAuth = Date.now();
  }
  return cli;
}
function who() { return playerLabel({ name: myName, id: myPid }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function pidOf(f) { const p = readJson(f); if (!p?.pid) return null; try { process.kill(p.pid, 0); return p.pid; } catch { return null; } }
function botPid() { return pidOf(PIDFILE); }
function gatherPid() { return pidOf(GPIDFILE); }
function combatPid() { return pidOf(CPIDFILE); }
function spawnBot(script, args, pidfile) {
  const child = cp.spawn('node', [path.join(ROOT, 'tools', script), ...args], { detached: true, stdio: 'ignore', cwd: ROOT });
  child.unref(); fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, started: Date.now() }));
  return child.pid;
}

// ---------- handlers ----------
async function hStatus() {
  await client().catch(() => null);
  const fr = botPid(), gr = gatherPid(), cb = combatPid(), or = pidOf(OPIDFILE);
  const gk = readJson(GPIDFILE)?.kind; const gLbl = gk === 'rock' ? '⛏Mining' : gk === 'tree' ? '🪓Wood' : 'Gather';
  let out = `🤖 <b>Kintara Bot Status</b> — ${who()}\n🧠 Auto: ${or ? '🟢 ON' : '🔴 OFF'} | Fishing: ${fr ? '🟢' : '🔴'} | ${gLbl}: ${gr ? '🟢' : '🔴'} | ⚔️Combat: ${cb ? '🟢' : '🔴'}`;
  if (or) {
    const o = readJson(path.join(OUT, 'orchestrator-state.json'));
    if (o) {
      const ageSec = o.ts ? Math.max(0, Math.round((Date.now() - o.ts) / 1000)) : null;
      out += `\n🎯 ${o.current} — ${o.why}${ageSec == null ? '' : `\n🕒 Last auto check: ${ageSec}s ago`}`;
    }
  }
  const s = readJson(path.join(OUT, 'bot-state.json'));
  if (fr && s) out += `\n🎣 fish: ${s.fish} | 🍳 cooked: ${s.cooked} | ✅ ${s.ok}/${s.casts} | 💰 ${s.sold || 0} | ⏱ ${s.ageMin}m`;
  const g = readJson(path.join(OUT, 'gather-state.json'));
  if (gr && g) out += `\n🪓 felled: ${g.felled} | 🪵 wood: ${g.wood} | 🪨 stone: ${g.stone} | coal: ${g.coal} | ⏱ ${g.ageMin}m`;
  const cs = readJson(path.join(OUT, 'combat-state.json'));
  if (cb && cs) {
    const phaseMap = {
      boot: 'boot',
      prep: 'prep',
      queue: cs.queueAhead != null ? `queue ${cs.queueAhead}` : 'queue',
      presence: 'presence',
      wild: 'wild',
      hunt: 'hunt',
      retreat: 'retreat',
      exit: 'exit',
      reconnect: 'reconnect',
    };
    const phaseLabel = cs.phase ? (phaseMap[cs.phase] || cs.phase) : null;
      out +=`⚔️ kill ${cs.kills || 0} | 🗡️ ${cs.hits || 0} | 📈 +${cs.combatGain || 0}XP | ❤️ ${cs.hp || 0} | 🧪 ${cs.potionsHealth || 0}H/${cs.potionsShield || 0}S | 🏃 ${cs.retreats || 0}${phaseLabel ? ` | 📍 ${phaseLabel}` : ''} | ⏱ ${fmtAgeMin(cs.ageMin)}`;
  } 
  return out;
}
async function hSkills() {
  const c = await client(); const st = await c.playerStats(myPid).catch(() => ({}));
  const xp = st.skillXp || {};
  return `📊 <b>Skills</b> — ${who()} (avg lvl ${st.avg || '?'})\n` +
    `⚔️ combat: ${xp.combat ?? 0}\n🪓 woodcutting: ${xp.woodcutting ?? 0}\n⛏ mining: ${xp.mining ?? 0}\n` +
    `🎣 fishing: ${xp.fishing ?? 0}\n🍳 cooking: ${xp.cooking ?? 0}\n🔨 smithing: ${xp.smithing ?? 0}\n` +
    `${(st.avg || 0) >= 5 ? '✅ Spinner unlocked (avg≥5)' : '🔒 Spinner requires avg 5'}`;
}
async function hBalance() {
  const c = await client(); const me = await c.me(); const bp = me.backpack || {};
  let tok = '';
  try { const t = await c.tokenBlimpStats(); tok = `\n🪙 $KINS: $${t.priceUsd} (${t.marketCapLabel})`; } catch {}
  return `💰 <b>Balance</b> — ${who()}\ngold: ${bp.gold || 0}\n🎣 fish: ${bp.fish || 0} | 🍳 cooked: ${bp.cooked_fish_meat || 0}\n🪵 wood: ${bp.wood || 0} | 🪨 stone: ${bp.stone || 0} | coal: ${bp.coal || 0} | metal: ${bp.metal || 0}${tok}`;
}
async function hQuest() {
  const c = await client(); const q = await c.dailyQuestProgress().catch(() => ({}));
  const dq = q?.dailyQuest || {}; const cfg = q?.dailyQuestConfig || {};
  if (!(cfg.quests || []).length) return `📋 <b>Daily Quest</b> — ${who()} (${dq.day || '?'})\n(no quest today yet)`;
  const lines = (cfg.quests || []).map((quest) => {
    const pr = (dq.prog || {})[quest.id] || 0; const cl = (dq.claimed || {})[quest.id];
    return `${cl ? '✅' : pr >= quest.target ? '🎁' : '▫️'} ${quest.label} — ${pr}/${quest.target} (${quest.rewardXpSpreadTotal}XP)`;
  });
  return `📋 <b>Daily Quest</b> — ${who()} (${dq.day})\n` + lines.join('\n');
}
async function hClaimQuests() {
  const c = await client(); const q = await c.dailyQuestProgress().catch(() => ({}));
  const dq = q?.dailyQuest || {}; const cfg = q?.dailyQuestConfig || {};
  const prog = dq.prog || {}; const claimed = dq.claimed || {};
  const ready = (cfg.quests || []).filter((quest) => !claimed[quest.id] && (prog[quest.id] || 0) >= quest.target);
  if (!ready.length) return `🎁 <b>Daily Quest Claim</b> — ${who()}\nNo completed quests ready to claim.`;

  const ok = [], failed = [];
  for (const quest of ready) {
    try {
      await c.dailyQuestClaim(quest.id);
      ok.push(`✅ ${quest.label || quest.kind} (${quest.rewardXpSpreadTotal || 0}XP)`);
    } catch (e) {
      failed.push(`⚠️ ${quest.label || quest.kind}: ${(e.message || '').slice(0, 60)}`);
    }
  }

  return `🎁 <b>Daily Quest Claim</b> — ${who()}\n` +
    (ok.length ? ok.join('\n') : 'No quests claimed.') +
    (failed.length ? `\n\n${failed.join('\n')}` : '');
}
function slotIsEmpty(slot) {
  return !slot || (
    !slot.t && !slot.type && !slot.id && !slot.itemType &&
    Number(slot.n || slot.count || 0) <= 0
  );
}
function spinnerGrantLabel(grant) {
  if (!grant || typeof grant !== 'object') return 'unknown reward';
  const type = String(grant.type || grant.itemType || 'unknown');
  const amount = Number(grant.amount || grant.n || grant.count || 0);
  const labels = {
    wood: '🪵 wood',
    stone: '🪨 stone',
    coal: 'coal',
    gold: 'gold',
    red_aura: 'Red Aura',
    cosmetic_red_aura: 'Red Aura',
  };
  const label = labels[type] || type;
  if (type === 'cosmetic_red_aura' || type === 'red_aura') return 'Red Aura cosmetic';
  if (type === 'gold') return amount === 1 ? '1 gold' : `${amount || 0} gold`;
  return `${amount || 0} ${label}`;
}
function spinnerResultMessage(result) {
  const grant = result?.grant || {};
  const winIndex = Number(result?.winIndex);
  const slot = Number.isFinite(winIndex) ? `\n🎯 Wheel slot: ${winIndex + 1}` : '';
  return `✅ Spin complete\n🎁 Reward: <b>${htmlEscape(spinnerGrantLabel(grant))}</b>${slot}`;
}
function formatDuration(ms) {
  const totalMin = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
async function hSpinner(args = []) {
  const allowedArgs = new Set(['force']);
  const unknownArg = args.find((x) => !allowedArgs.has(String(x || '').toLowerCase()));
  if (unknownArg) return `🎡 <b>Free Spinner</b>\nUsage: /spinner\nUse /spinner force only to bypass the cosmetic-slot precheck.`;

  if (spinnerBusy) return `🎡 <b>Free Spinner</b> — ${who()}\n⏳ Spinner request already in progress.`;

  const force = args.map((x) => String(x || '').toLowerCase()).includes('force');
  const fr = botPid(), gr = gatherPid(), cb = combatPid();
  if (fr || gr || cb) {
    return `🎡 <b>Free Spinner</b> — ${who()}\n⚠️ Stop fishing/gathering/combat before spinning. Spinner and workers can both update backpack state, so spinning during an active worker could overwrite rewards.\n\nRun /stop, then /spinner.`;
  }

  spinnerBusy = true;
  try {
    const c = await client();
    const st = await c.playerStats(myPid).catch(() => ({}));
    const avg = Number(st.avg || 0);
    if (avg < 5) return `🎡 <b>Free Spinner</b> — ${who()}\n🔒 Requires average level 5. Current avg: ${st.avg || '?'}`;

    const me = await c.me().catch(() => null);
    if (!me?.ok || !me.backpack) return `🎡 <b>Free Spinner</b> — ${who()}\n⚠️ Could not read current backpack/session state. Try again later.`;
    const bp = me.backpack || {};
    const lastSpinMs = Number(me?.meta?.dailySpinnerLastMs || me?.dailySpinnerLastMs || 0);
    if (Number.isFinite(lastSpinMs) && lastSpinMs > 0) {
      const remaining = DAILY_SPINNER_COOLDOWN_MS - (Date.now() - lastSpinMs);
      if (remaining > 0) return `🎡 <b>Free Spinner</b> — ${who()}\n⏳ Cooldown active. Try again in ${formatDuration(remaining)}.`;
    }

    const cosmeticSlots = Array.isArray(bp.cosmeticSlots) ? bp.cosmeticSlots : [];
    const freeCosmeticSlots = cosmeticSlots.filter(slotIsEmpty).length;
    if (cosmeticSlots.length && freeCosmeticSlots === 0 && !force) {
      return `🎡 <b>Free Spinner</b> — ${who()}\n⚠️ Cosmetic bag looks full. Free one cosmetic slot before spinning, because the rare Red Aura reward needs space.\n\nIf you still want to spin anyway: /spinner force`;
    }

    const r = await c.dailySpinnerSpin();
    if (!r || r.ok === false || !r.grant) return `🎡 <b>Free Spinner</b> — ${who()}\n⚠️ Spin response was incomplete. Check in-game before retrying.`;
    const newBp = r?.backpack || {};
    return `🎡 <b>Free Spinner</b> — ${who()}\n${spinnerResultMessage(r)}` +
      `\n🪵 wood: ${newBp.wood ?? bp.wood ?? 0} | 🪨 stone: ${newBp.stone ?? bp.stone ?? 0} | coal: ${newBp.coal ?? bp.coal ?? 0} | gold: ${newBp.gold ?? bp.gold ?? 0}`;
  } catch (e) {
    const err = e.body?.error || e.message || 'unknown_error';
    if (e.status === 429) return `🎡 <b>Free Spinner</b> — ${who()}\n⏳ Spinner is on cooldown. Try again later.`;
    if (err === 'spinner_level_required') return `🎡 <b>Free Spinner</b> — ${who()}\n🔒 Requires average level 5.`;
    if (err === 'inventory_full') return `🎡 <b>Free Spinner</b> — ${who()}\n⚠️ Inventory/cosmetic bag is full. Free one cosmetic slot and try again.`;
    return `🎡 <b>Free Spinner</b> — ${who()}\n⚠️ Spin failed: ${String(err).slice(0, 80)}`;
  } finally {
    spinnerBusy = false;
  }
}
function hStartFish() {
  if (gatherPid() || combatPid()) return '⚠️ Another bot is ON — run /stop first (1 account = 1 activity).';
  if (botPid()) return '🎣 Fishing bot is already ON.';
  const pid = spawnBot('bot-headless.js', [config.shard], PIDFILE);
  return `🎣 Fishing bot START (pid ${pid}). Queues for ~10min, then grinds+cooks. Check /status.`;
}
function hStartGather(args) {
  if (botPid() || combatPid()) return '⚠️ Another bot is ON — run /stop first (1 account = 1 activity).';
  const kind = (args[0] === 'rock' || args[0] === 'stone' || args[0] === 'coal' || args[0] === 'mine') ? 'rock' : 'tree';
  const lbl = kind === 'rock' ? '⛏ mine stone/coal' : '🪓 chop wood';
  const running = gatherPid(); const cur = readJson(GPIDFILE);
  if (running && cur?.kind === kind) return `${lbl} is already ON.`;
  if (running) stopPidFile(GPIDFILE, { signal: 'SIGTERM' }); // switch kind
  const pid = spawnBot('gather-bot.js', [kind, config.shard], GPIDFILE);
  fs.writeFileSync(GPIDFILE, JSON.stringify({ pid, kind, started: Date.now() })); // save kind
  return `${lbl} START (pid ${pid})${running ? ' [switched from ' + (cur?.kind || '?') + ']' : ''}. Queues for ~10min. Check /status.`;
}

function hStartCombat() {
  if (botPid() || gatherPid() || pidOf(OPIDFILE)) return '⚠️ Another bot is ON — run /stop first (1 account = 1 activity).';
  if (combatPid()) return '⚔️ Combat bot is already ON.';
  const pid = spawnBot('combat-bot.js', [config.shard], CPIDFILE);
  return `⚔️ Combat bot START (pid ${pid}).\n🏦 Banks loot first for safety → enters Wilderness → hunts zombies.\n🛡️ Auto-potion + retreat on critical HP. Queue can take ~10min. Check /status.\n\n<i>⚠️ Wilderness has PvP risk. Banked loot stays safe even if you die.</i>`;
}

function hAuto() {
  if (pidOf(OPIDFILE)) return '🧠 Orchestrator is already ON.';
  if (combatPid()) return '⚔️ Combat bot is already ON.';
  const pid = spawnBot('orchestrator.js', [], OPIDFILE);
  return `🧠 Orchestrator START (pid ${pid}) — auto-selects fishing/gather by goal. Use /stop to turn it off.`;
}
function hStop() {
  let msg = [];
  // stop orchestrator first so it does not restart bots
  for (const [name, pf] of MANAGED_BOTS) {
    const pid = pidOf(pf);
    if (pid) { stopPidFile(pf, { signal: 'SIGTERM' }); msg.push(`🛑 ${name} STOP (pid ${pid})`); }
  }
  return msg.length ? msg.join('\n') : '🔴 All bots are already OFF.';
}

function hHelp() {
  return `🤖 <b>Kintara Bot — Commands</b>\n` +
    `/status — bot status and inventory\n/skills — XP and skill levels\n/balance — gold/$KINS/resources\n/quest — daily quest\n/claim — claim completed daily quests\n` +
    `/spinner — free daily spinner\n/fish — fishing + cooking\n/gather — chop wood 🪓\n/mine — mine stone/coal ⛏\n/combat — hunt Wilderness zombies ⚔️\n/auto — auto-select activity 🧠\n/stop — stop all bots\n/help — command list\n\n` +
    `<i>1 account = 1 activity for safer automation. Combat banks first and uses auto-survival.</i>`;
}

const commands = {
  start: () => hHelp(), help: () => hHelp(),
  status: hStatus, skills: hSkills, balance: hBalance, saldo: hBalance,
  quest: hQuest, claim: hClaimQuests, claimquests: hClaimQuests, fish: hStartFish, stop: hStop,
  spinner: hSpinner, spin: hSpinner,
  gather: hStartGather, chop: hStartGather, mine: () => hStartGather(['rock']),
  auto: hAuto, combat: hStartCombat,
  sell: () => '💰 Sell is active after the tutorial is complete.',
};

// Set Telegram menu commands to only the currently supported commands, removing old ones
const MENU = [
  { command: 'fish', description: '🎣 Fishing + cooking' },
  { command: 'gather', description: '🪓 Chop wood' },
  { command: 'mine', description: '⛏ Mining stone/coal' },
  { command: 'combat', description: '⚔️ Wilderness combat' },
  { command: 'auto', description: '🧠 Auto-select activity' },
  { command: 'stop', description: '⏹️ Stop all bots' },
  { command: 'status', description: '📊 Bot status + inventory' },
  { command: 'skills', description: '📈 Skill levels & XP' },
  { command: 'balance', description: '💰 Gold/$KINS/resources' },
  { command: 'quest', description: '📋 Daily quest' },
  { command: 'claim', description: '🎁 Claim completed quests' },
  { command: 'spinner', description: '🎡 Free spinner wheel' },
  { command: 'help', description: '❓ Command list' },
];
async function syncMenu() {
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/setMyCommands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: MENU }),
    });
    console.log('[telegram-bot] menu commands synced (' + MENU.length + ' command)');
  } catch (e) { console.error('syncMenu err', e.message); }
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'control'), { recursive: true });
  await syncMenu();
  await tg.send('🤖 <b>Kintara Bot online!</b> Send /help for the command list.').catch(() => {});
  console.log('[telegram-bot] polling...');
  for (; !isShuttingDown();) {
    try { await tg.pollCommands(commands); } catch (e) { console.error('poll err', e.message); }
    await sleep(2000);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
