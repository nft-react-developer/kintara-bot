// ============ BROWSER SESSION — drive the real game client ============
// Reusable: launch cached Chromium + inject kintara_session cookie,
// open /play, join a server (all FULL -> queue), and wait for admission to the world.
// Used by tools/move-test.js and, later, the persistent farmer.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = '/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function sessionCookie() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const m = env.match(/KINTARA_SESSION_COOKIE=(\S+)/);
  if (!m) throw new Error('KINTARA_SESSION_COOKIE is missing from .env');
  const raw = m[1]; const eq = raw.indexOf('=');
  return { name: raw.slice(0, eq), value: raw.slice(eq + 1) };
}

async function launchBrowser() {
  const cookie = sessionCookie();
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: 'kintara.gg', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

/**
 * Open /play, join a server by clicking a card, and wait until the world loads.
 * @param {import('playwright-core').Page} page
 * @param {(s:string)=>void} log
 * @param {number} maxMin queue wait limit in minutes
 * @returns {Promise<boolean>} true when entering the world succeeds
 */
async function enterWorld(page, log = console.log, maxMin = 25) {
  await page.goto('https://kintara.gg/play', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('button.kintara-server-card', { timeout: 50000 });
  await page.waitForTimeout(2000);

  const card = page.locator('button.kintara-server-card', { hasText: /SERVER\s*\d/i }).first();
  let clicked = false;
  for (let i = 0; i < 5 && !clicked; i++) {
    try { const t = await card.innerText().catch(() => '?'); await card.click({ force: true, timeout: 8000 }); clicked = true; log('joined: ' + t.replace(/\n/g, ' ').slice(0, 40)); }
    catch (e) { log(`join attempt ${i} fail: ${e.message.slice(0, 50)}`); await page.waitForTimeout(1500); }
  }
  if (!clicked) return false;

  const deadline = Date.now() + maxMin * 60000;
  let tick = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(8000); tick++;
    const st = await page.evaluate(() => {
      const bf = document.querySelector('.kintara-boot__frame');
      const boot = document.querySelector('.kintara-boot__phase');
      const body = document.body.innerText || '';
      return { bootVisible: !!(bf && bf.offsetParent !== null), queueing: /IN QUEUE|PLEASE WAIT|CHOOSE A SERVER|SELECT A SERVER|LOADING/i.test(body), phase: boot ? (boot.innerText || '').slice(0, 30) : null };
    });
    if (tick % 4 === 0) log(`t+${tick * 8}s boot=${st.bootVisible} q=${st.queueing} phase="${st.phase}"`);
    if (!st.bootVisible && !st.queueing) {
      await page.waitForTimeout(5000);
      const ok = await page.evaluate(() => { const bf = document.querySelector('.kintara-boot__frame'); return !(bf && bf.offsetParent !== null) && !/IN QUEUE|PLEASE WAIT|SELECT A SERVER|CHOOSE A SERVER/i.test(document.body.innerText || ''); });
      if (ok) { log('✅ ENTERED WORLD (t+' + tick * 8 + 's)'); return true; }
    }
  }
  return false;
}

/** Get the main gameplay canvas (largest) for click-to-move / coordinates. */
async function mainCanvasBox(page) {
  return page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')];
    let best = null, area = 0;
    for (const c of cs) { const r = c.getBoundingClientRect(); const a = r.width * r.height; if (a > area) { area = a; best = r; } }
    return best ? { x: best.x, y: best.y, w: best.width, h: best.height } : null;
  });
}

module.exports = { launchBrowser, enterWorld, mainCanvasBox, sessionCookie, EXE };
