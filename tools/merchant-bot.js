#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { KintaraClient } = require('../lib/kintaraClient');
const { Presence } = require('../lib/presenceWs');
const { normalizeMerchantCost } = require('../lib/merchantCommand');
const { createMerchantLogger } = require('../lib/merchantRuntime');
const { spawnToMerchantPresenceState, runMerchantTrade } = require('../lib/merchantTrade');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const CONTROL = path.join(OUT, 'control');
const PIDFILE = path.join(CONTROL, 'merchantbot.pid');
const JOBFILE = path.join(CONTROL, 'merchant-job.json');
const RESULTFILE = path.join(CONTROL, 'merchant-result.json');
const STATEFILE = path.join(CONTROL, 'merchant-job-state.json');
const LOGFILE = path.join(OUT, 'merchant.log');
const shard = process.argv[2] || config.shard || 's6';
const log = createMerchantLogger(LOGFILE);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function saveState(phase, extra = {}) {
  writeJson(STATEFILE, { phase, shard, updatedAt: Date.now(), ...extra });
}

async function main() {
  const job = readJson(JOBFILE);
  if (!job) throw new Error('merchant job file is missing');
  const cost = normalizeMerchantCost(job.cost);
  try { fs.unlinkSync(RESULTFILE); } catch {}
  saveState('auth');
  log('worker_start', { shard, maxTradesAtDetection: job.maxTrades, resumeService: job.resumeService || null });
  const { client, player } = await KintaraClient.create();
  const me = await client.me();
  const initialState = spawnToMerchantPresenceState(me?.meta?.spawn);
  const presence = new Presence(shard, { synchronizeSelf: true });
  presence.setCookie(client.cookie, player);
  presence.seedSelfState(initialState);
  presence.on('queue', (message) => {
    const ahead = Number.isFinite(Number(message?.ahead)) ? Number(message.ahead) : null;
    saveState('queue', { queueAhead: ahead });
    log('queue_update', { ahead });
  });
  presence.on('log', (message) => log('presence', String(message)));
  try {
    saveState('connecting');
    await presence.connect();
    const result = await runMerchantTrade({
      presence,
      client,
      cost,
      campaign: job.campaign || null,
      log: (event, details) => {
        const phase = event.includes('walk') || event.includes('region') ? 'navigating'
          : event.includes('trade') ? 'trading'
            : 'running';
        saveState(phase, { region: presence.region, x: presence.pos?.x, z: presence.pos?.z, event });
        log(event, details);
      },
    });
    const payload = { ...result, finishedAt: Date.now() };
    writeJson(RESULTFILE, payload);
    saveState('complete', payload);
    log('worker_complete', { traded: result.traded, reason: result.reason, resetAtMs: result.resetAtMs });
  } finally {
    presence.close();
  }
}

fs.mkdirSync(CONTROL, { recursive: true });
process.on('exit', () => { try { fs.unlinkSync(PIDFILE); } catch {} });

main().catch((error) => {
  const payload = { ok: false, traded: 0, reason: String(error?.message || error).slice(0, 200), finishedAt: Date.now() };
  try { writeJson(RESULTFILE, payload); } catch {}
  try { saveState('failed', payload); } catch {}
  try { log('worker_failed', payload); } catch {}
  process.exitCode = 1;
});
