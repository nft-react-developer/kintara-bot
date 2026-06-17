// ============ WALLET AUTH — headless login using a Solana private key ============
// Replicates the client flow (auth-gate.js): GET /api/auth/challenge -> sign message
// with ed25519 -> POST /api/auth/verify -> receive kintara_session cookie.
// Removes the dependency on manual expiring cookies. Uses WALLET_PRIVATE_KEY (base58).
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { config } = require('../config');

const API = config.apiBase || 'https://kintara.gg';

/** Builds a keypair from WALLET_PRIVATE_KEY (base58; 64-byte secret or 32-byte seed). */
function loadKeypair(b58key) {
  const raw = bs58.decode(b58key.trim());
  if (raw.length === 64) return nacl.sign.keyPair.fromSecretKey(raw);
  if (raw.length === 32) return nacl.sign.keyPair.fromSeed(raw);
  throw new Error(`Unexpected WALLET_PRIVATE_KEY length ${raw.length} (must be a 32 or 64 byte base58 value)`);
}

function pickCookie(setCookieHeader) {
  // Extract kintara_session=... from the Set-Cookie header
  if (!setCookieHeader) return null;
  const m = setCookieHeader.match(/kintara_session=[^;]+/);
  return m ? m[0] : null;
}

/**
 * Login penuh. @returns {Promise<{cookie:string, player:object, raw:object}>}
 * cookie is ready to use as the Cookie header (format: "kintara_session=...").
 */
async function login(b58key = config.walletPrivateKey) {
  if (!b58key) throw new Error('WALLET_PRIVATE_KEY is not set in .env');
  const kp = loadKeypair(b58key);
  const publicKey = bs58.encode(Buffer.from(kp.publicKey));

  // 1) challenge; may set a temporary session cookie that we forward
  const chRes = await fetch(`${API}/api/auth/challenge`, { headers: { Accept: 'application/json' } });
  const chCookie = pickCookie(chRes.headers.get('set-cookie'));
  const ch = await chRes.json();
  if (!ch?.ok || !ch.challengeId || !ch.message) throw new Error('challenge failed: ' + JSON.stringify(ch).slice(0, 200));

  // 2) sign message (UTF-8 bytes) with ed25519
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
  if (!vRes.ok || !data?.ok) throw new Error('verify failed: ' + JSON.stringify(data).slice(0, 200));
  if (!sessionCookie) throw new Error('verify succeeded but no kintara_session Set-Cookie was returned');

  return { cookie: sessionCookie, player: data.player, raw: data };
}

module.exports = { login, loadKeypair };

// ---- CLI test ----
if (require.main === module) {
  login()
    .then((r) => { console.log('✅ LOGIN OK'); console.log('player:', JSON.stringify(r.player)); console.log('cookie:', r.cookie.slice(0, 40) + '... (len ' + r.cookie.length + ')'); })
    .catch((e) => { console.error('🛑 LOGIN FAILED:', e.message); process.exit(1); });
}
