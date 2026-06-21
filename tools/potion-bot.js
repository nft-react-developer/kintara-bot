#!/usr/bin/env node
// One-shot worker: synchronize the live position, visit the alchemist, buy potions,
// return to Mainland, and persist a result for the Telegram controller.
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { Presence } = require('../lib/presenceWs');
const { KintaraClient } = require('../lib/kintaraClient');
const { normalizePotionType, parsePotionQuantity } = require('../lib/potionCommand');
const { runPotionPurchase } = require('../lib/potionPurchase');

const potionType = normalizePotionType(process.argv[2]);
const quantity = parsePotionQuantity(process.argv[3]);
const shard = process.argv[4] || config.shard || 's4';
const OUT = path.join(__dirname, '..', 'recon');
const CONTROL = path.join(OUT, 'control');
const STATEFILE = path.join(OUT, 'potion-state.json');
const RESULTFILE = path.join(CONTROL, 'potion-result.json');
const LOGFILE = path.join(OUT, 'potion.log');

function madridTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function log(...args) {
  const line = `[${madridTimestamp()} Europe/Madrid] ${args.join(' ')}`;
  console.log(line);
  fs.mkdirSync(OUT, { recursive: true });
  fs.appendFileSync(LOGFILE, line + '\n');
}

function saveState(phase, extra = {}) {
  writeJson(STATEFILE, {
    phase,
    potionType,
    requested: quantity,
    shard,
    updatedAt: madridTimestamp(),
    timeZone: 'Europe/Madrid',
    ...extra,
  });
}

async function main() {
  if (!potionType) throw new Error(`Invalid potion type: ${process.argv[2] || ''}`);
  if (!quantity) throw new Error(`Invalid potion quantity: ${process.argv[3] || ''}`);
  try { fs.unlinkSync(RESULTFILE); } catch {}

  saveState('auth');
  log(`Starting potion worker type=${potionType} quantity=${quantity} shard=${shard}`);
  const { client, player } = await KintaraClient.create();
  const presence = new Presence(shard, { synchronizeSelf: true });
  presence.setCookie(client.cookie, player);
  presence.on('log', (message) => log('[ws]', message));
  presence.on('queue', (message) => {
    const ahead = Number.isFinite(Number(message?.ahead)) ? Number(message.ahead) : null;
    saveState('queue', { queueAhead: ahead });
    log(`Queue position ahead=${ahead ?? '?'}`);
  });

  try {
    saveState('connecting');
    await presence.connect();
    saveState('synchronizing');
    const result = await runPotionPurchase({
      presence,
      client,
      potionType,
      quantity,
      log: (message) => {
        const phase = /Synchronizing/.test(message) ? 'synchronizing'
          : /Walking|Entered|Arrived|Already/.test(message) ? 'navigating'
            : /Buying|purchase/.test(message) ? 'buying'
              : /Returned/.test(message) ? 'returning'
                : 'running';
        saveState(phase, { region: presence.region, x: presence.pos?.x, z: presence.pos?.z });
        log(message);
      },
    });
    const payload = {
      ok: true,
      ...result,
      finishedAt: madridTimestamp(),
      timeZone: 'Europe/Madrid',
    };
    writeJson(RESULTFILE, payload);
    saveState('complete', payload);
    log(`Potion worker complete purchased=${result.purchased}/${result.requested}`);
  } finally {
    presence.close();
  }
}

main().catch((error) => {
  const payload = {
    ok: false,
    potionType: potionType || process.argv[2] || null,
    requested: quantity || Number(process.argv[3]) || 0,
    purchased: 0,
    reason: String(error?.message || error).slice(0, 200),
    finishedAt: madridTimestamp(),
    timeZone: 'Europe/Madrid',
  };
  try { writeJson(RESULTFILE, payload); } catch {}
  try { saveState('failed', payload); } catch {}
  log(`Potion worker failed: ${payload.reason}`);
  process.exitCode = 1;
});
