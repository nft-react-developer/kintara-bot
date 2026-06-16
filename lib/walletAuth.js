// ============ WALLET AUTH — login headless pakai Solana private key ============
// Replikasi flow client (auth-gate.js): GET /api/auth/challenge -> sign message
// ed25519 -> POST /api/auth/verify -> dapat cookie kintara_session.
// Menghapus ketergantungan cookie manual (yg expired). Pakai WALLET_PRIVATE_KEY (base58).
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { config } = require('../config');

const API = config.apiBase || 'https://kintara.gg';

/** keypair dari WALLET_PRIVATE_KEY (base58; 64-byte secret atau 32-byte seed). */
function loadKeypair(b58key) {
  const raw = bs58.decode(b58key.trim());
  if (raw.length === 64) return nacl.sign.keyPair.fromSecretKey(raw);
  if (raw.length === 32) return nacl.sign.keyPair.fromSeed(raw);
  throw new Error(`WALLET_PRIVATE_KEY len ${raw.length} tak terduga (harus 32 atau 64 byte base58)`);
}

function pickCookie(setCookieHeader) {
  // ambil kintara_session=... dari header Set-Cookie
  if (!setCookieHeader) return null;
  const m = setCookieHeader.match(/kintara_session=[^;]+/);
  return m ? m[0] : null;
}

/**
 * Login penuh. @returns {Promise<{cookie:string, player:object, raw:object}>}
 * cookie siap dipakai sebagai header Cookie (format "kintara_session=...").
 */
async function login(b58key = config.walletPrivateKey) {
  if (!b58key) throw new Error('WALLET_PRIVATE_KEY belum diset di .env');
  const kp = loadKeypair(b58key);
  const publicKey = bs58.encode(Buffer.from(kp.publicKey));

  // 1) challenge (bisa set cookie sesi sementara — kita teruskan)
  const chRes = await fetch(`${API}/api/auth/challenge`, { headers: { Accept: 'application/json' } });
  const chCookie = pickCookie(chRes.headers.get('set-cookie'));
  const ch = await chRes.json();
  if (!ch?.ok || !ch.challengeId || !ch.message) throw new Error('challenge gagal: ' + JSON.stringify(ch).slice(0, 200));

  // 2) sign message (UTF-8 bytes) dgn ed25519
  const sig = nacl.sign.detached(Buffer.from(ch.message, 'utf8'), kp.secretKey);

  // 3) verify
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (chCookie) headers.Cookie = chCookie;
  const vRes = await fetch(`${API}/api/auth/verify`, {
    method: 'POST', headers,
    body: JSON.stringify({ publicKey, signature: Array.from(sig), message: ch.message, challengeId: ch.challengeId }),
  });
  const sessionCookie = pickCookie(vRes.headers.get('set-cookie')) || chCookie;
  const data = await vRes.json();
  if (!vRes.ok || !data?.ok) throw new Error('verify gagal: ' + JSON.stringify(data).slice(0, 200));
  if (!sessionCookie) throw new Error('verify ok tapi tidak ada Set-Cookie kintara_session');

  return { cookie: sessionCookie, player: data.player, raw: data };
}

module.exports = { login, loadKeypair };

// ---- CLI test ----
if (require.main === module) {
  login()
    .then((r) => { console.log('✅ LOGIN OK'); console.log('player:', JSON.stringify(r.player)); console.log('cookie:', r.cookie.slice(0, 40) + '... (len ' + r.cookie.length + ')'); })
    .catch((e) => { console.error('🛑 LOGIN GAGAL:', e.message); process.exit(1); });
}
