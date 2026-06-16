#!/usr/bin/env node
// ============ TELEGRAM CONTROL BOT — kontrol + status headless bot ============
// Kontrol bot Kintara via Telegram: status, skill, saldo, quest, start/stop fishing.
// Pakai lib/telegram (long-poll). Token+chatId dari .env (auto-capture chat id
// saat pertama kirim pesan ke bot).
//
// Pakai: node tools/telegram-bot.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const tg = require('../lib/telegram');
const { KintaraClient } = require('../lib/kintaraClient');
const { login } = require('../lib/walletAuth');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const PIDFILE = path.join(OUT, 'control', 'fishbot.pid');
const GPIDFILE = path.join(OUT, 'control', 'gatherbot.pid');
const OPIDFILE = path.join(OUT, 'control', 'orch.pid');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cli = null, lastAuth = 0, myPid = null;
async function client() {
  if (!cli || Date.now() - lastAuth > 1500000) { const a = await login(); cli = new KintaraClient({ cookie: a.cookie }); myPid = a.player?.id || myPid; lastAuth = Date.now(); }
  return cli;
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function pidOf(f) { const p = readJson(f); if (!p?.pid) return null; try { process.kill(p.pid, 0); return p.pid; } catch { return null; } }
function botPid() { return pidOf(PIDFILE); }
function gatherPid() { return pidOf(GPIDFILE); }
function spawnBot(script, args, pidfile) {
  const child = cp.spawn('node', [path.join(ROOT, 'tools', script), ...args], { detached: true, stdio: 'ignore', cwd: ROOT });
  child.unref(); fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, started: Date.now() }));
  return child.pid;
}

// ---------- handlers ----------
async function hStatus() {
  const fr = botPid(), gr = gatherPid(), or = pidOf(OPIDFILE);
  const gk = readJson(GPIDFILE)?.kind; const gLbl = gk === 'rock' ? '⛏Mining' : gk === 'tree' ? '🪓Wood' : 'Gather';
  let out = `🤖 <b>Status Bot Kintara</b>\n🧠 Auto: ${or ? '🟢 ON' : '🔴 OFF'} | Fishing: ${fr ? '🟢' : '🔴'} | ${gLbl}: ${gr ? '🟢' : '🔴'}`;
  if (or) { const o = readJson(path.join(OUT, 'orchestrator-state.json')); if (o) out += `\n🎯 ${o.current} — ${o.why}`; }
  const s = readJson(path.join(OUT, 'bot-state.json'));
  if (fr && s) out += `\n🎣 fish: ${s.fish} | 🍳 cooked: ${s.cooked} | ✅ ${s.ok}/${s.casts} | 💰 ${s.sold || 0} | ⏱ ${s.ageMin}m`;
  const g = readJson(path.join(OUT, 'gather-state.json'));
  if (gr && g) out += `\n🪓 felled: ${g.felled} | 🪵 wood: ${g.wood} | 🪨 stone: ${g.stone} | coal: ${g.coal} | ⏱ ${g.ageMin}m`;
  return out;
}
async function hSkills() {
  const c = await client(); const st = await c.playerStats(myPid).catch(() => ({}));
  const xp = st.skillXp || {};
  return `📊 <b>Skills</b> (avg lvl ${st.avg || '?'})\n` +
    `⚔️ combat: ${xp.combat ?? 0}\n🪓 woodcutting: ${xp.woodcutting ?? 0}\n⛏ mining: ${xp.mining ?? 0}\n` +
    `🎣 fishing: ${xp.fishing ?? 0}\n🍳 cooking: ${xp.cooking ?? 0}\n🔨 smithing: ${xp.smithing ?? 0}\n` +
    `${(st.avg || 0) >= 5 ? '✅ Spinner unlocked (avg≥5)' : '🔒 Spinner butuh avg 5'}`;
}
async function hBalance() {
  const c = await client(); const me = await c.me(); const bp = me.backpack || {};
  let tok = '';
  try { const t = await c.tokenBlimpStats(); tok = `\n🪙 $KINS: $${t.priceUsd} (${t.marketCapLabel})`; } catch {}
  return `💰 <b>Saldo</b>\ngold: ${bp.gold || 0}\n🎣 fish: ${bp.fish || 0} | 🍳 cooked: ${bp.cooked_fish_meat || 0}\n🪵 wood: ${bp.wood || 0} | 🪨 stone: ${bp.stone || 0} | coal: ${bp.coal || 0} | metal: ${bp.metal || 0}${tok}`;
}
async function hQuest() {
  const c = await client(); const q = await c.dailyQuestProgress().catch(() => ({}));
  const dq = q?.dailyQuest || {}; const cfg = q?.dailyQuestConfig || {};
  if (!(cfg.quests || []).length) return `📋 <b>Daily Quest</b> (${dq.day || '?'})\n(belum ada quest hari ini)`;
  const lines = (cfg.quests || []).map((quest) => {
    const pr = (dq.prog || {})[quest.id] || 0; const cl = (dq.claimed || {})[quest.id];
    return `${cl ? '✅' : pr >= quest.target ? '🎁' : '▫️'} ${quest.label} — ${pr}/${quest.target} (${quest.rewardXpSpreadTotal}XP)`;
  });
  return `📋 <b>Daily Quest</b> (${dq.day})\n` + lines.join('\n');
}
function hStartFish() {
  if (gatherPid()) return '⚠️ Gather bot ON — /stop dulu (1 akun = 1 aktivitas).';
  if (botPid()) return '🎣 Fishing bot udah ON.';
  const pid = spawnBot('bot-headless.js', ['s2'], PIDFILE);
  return `🎣 Fishing bot START (pid ${pid}). Antri ~10min lalu grind+cook. Cek /status.`;
}
function hStartGather(args) {
  if (botPid()) return '⚠️ Fishing bot ON — /stop dulu (1 akun = 1 aktivitas).';
  const kind = (args[0] === 'rock' || args[0] === 'stone' || args[0] === 'coal' || args[0] === 'mine') ? 'rock' : 'tree';
  const lbl = kind === 'rock' ? '⛏ mining stone/coal' : '🪓 chop wood';
  const running = gatherPid(); const cur = readJson(GPIDFILE);
  if (running && cur?.kind === kind) return `${lbl} udah ON.`;
  if (running) { try { process.kill(running, 'SIGKILL'); } catch {} try { fs.unlinkSync(GPIDFILE); } catch {} } // switch kind
  const pid = spawnBot('gather-bot.js', [kind, 's2'], GPIDFILE);
  fs.writeFileSync(GPIDFILE, JSON.stringify({ pid, kind, started: Date.now() })); // simpan kind
  return `${lbl} START (pid ${pid})${running ? ' [switch dari ' + (cur?.kind || '?') + ']' : ''}. Antri ~10min. Cek /status.`;
}
function hAuto() {
  if (pidOf(OPIDFILE)) return '🧠 Orchestrator udah ON.';
  const pid = spawnBot('orchestrator.js', [], OPIDFILE);
  return `🧠 Orchestrator START (pid ${pid}) — auto-pilih fishing/gather by goal. /stop utk matikan.`;
}
function hStop() {
  let msg = [];
  // matikan orchestrator dulu (biar gak restart bot)
  for (const [name, pf] of [['Orchestrator', OPIDFILE], ['Fishing', PIDFILE], ['Gather', GPIDFILE]]) {
    const pid = pidOf(pf);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} try { fs.unlinkSync(pf); } catch {} msg.push(`🛑 ${name} STOP (pid ${pid})`); }
  }
  return msg.length ? msg.join('\n') : '🔴 Semua bot udah OFF.';
}
function hHelp() {
  return `🤖 <b>Kintara Bot — Perintah</b>\n` +
    `/status — status bot & inventory\n/skills — XP & level skill\n/balance — gold/$KINS/resource\n/quest — daily quest\n` +
    `/fish — fishing + cooking\n/gather — chop wood 🪓\n/mine — mining stone/coal ⛏\n/auto — orchestrator pilih otomatis 🧠\n/stop — STOP semua\n/help — bantuan\n\n` +
    `<i>1 akun = 1 aktivitas (lebih aman anti-cheat). /combat segera.</i>`;
}

const commands = {
  start: () => hHelp(), help: () => hHelp(),
  status: hStatus, skills: hSkills, balance: hBalance, saldo: hBalance,
  quest: hQuest, fish: hStartFish, stop: hStop,
  gather: hStartGather, chop: hStartGather, mine: () => hStartGather(['rock']),
  auto: hAuto, combat: () => '⚔️ Combat lagi disiapkan (RE pesan combat WS + survival).',
  sell: () => '💰 Sell aktif setelah tutorial selesai.',
};

// Set menu command Telegram = HANYA yg dipakai sekarang (hapus sisa lama)
const MENU = [
  { command: 'fish', description: '🎣 Fishing + cooking' },
  { command: 'gather', description: '🪓 Chop wood' },
  { command: 'mine', description: '⛏ Mining stone/coal' },
  { command: 'auto', description: '🧠 Auto-pilih aktivitas' },
  { command: 'stop', description: '⏹️ Stop semua bot' },
  { command: 'status', description: '📊 Status bot + inventory' },
  { command: 'skills', description: '📈 Level & XP skill' },
  { command: 'balance', description: '💰 Gold/$KINS/resource' },
  { command: 'quest', description: '📋 Daily quest' },
  { command: 'help', description: '❓ Daftar command' },
];
async function syncMenu() {
  try {
    const { config } = require('../config');
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/setMyCommands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: MENU }),
    });
    console.log('[telegram-bot] menu command di-sync (' + MENU.length + ' command)');
  } catch (e) { console.error('syncMenu err', e.message); }
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'control'), { recursive: true });
  await syncMenu();
  await tg.send('🤖 <b>Kintara Bot online!</b> Ketik /help buat daftar perintah.').catch(() => {});
  console.log('[telegram-bot] polling...');
  for (;;) {
    try { await tg.pollCommands(commands); } catch (e) { console.error('poll err', e.message); }
    await sleep(2000);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
