// ============ WALLET AUTH — headless login with Solana private key ============
// Replicates the client flow (auth-gate.js): GET /api/auth/challenge -> sign message
// ed25519 -> POST /api/auth/verify -> obtain the kintara_session cookie.
// Removes the dependency on manual cookies, which expire. Use WALLET_PRIVATE_KEY (base58).
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { config } = require('../config');

const API = config.apiBase || 'https://kintara.gg';

function parseJsonSafely(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

function isMaintenanceResponse(status, text) {
  const body = String(text || '');
  return Number(status) === 503 || /under maintenance|<!doctype html>|<html/i.test(body);
}

/** Build a keypair from WALLET_PRIVATE_KEY (base58; 64-byte secret or 32-byte seed). */
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

function buildAuthError(stage, data, status = 0) {
  const errCode = data?.error || data?.code || '';
  const err = new Error(
    errCode === 'wallet_banned'
      ? 'This wallet is banned by the server (`wallet_banned`), so the bot cannot log in.'
      : `${stage} failed: ${JSON.stringify(data).slice(0, 200)}`
  );
  err.code = errCode || `AUTH_${String(stage).toUpperCase()}_FAILED`;
  err.status = status;
  err.authStage = stage;
  err.authBody = data;
  return err;
}

function isWalletBannedError(err) {
  return err?.code === 'wallet_banned' || /wallet_banned/i.test(err?.message || '');
}

const LOGIN_RETRY_MAX = 3;
const LOGIN_RETRY_BASE_MS = 8000;
let _lastLoginAttempt = 0;
const LOGIN_COOLDOWN_MS = 5000;

function isRetryable502(status, text) {
  return Number(status) === 502 || /bad.?gateway|origin_bad_gateway/i.test(String(text || ''));
}

async function _loginOnce(b58key) {
  const kp = loadKeypair(b58key);
  const publicKey = bs58.encode(Buffer.from(kp.publicKey));

  const chRes = await fetch(`${API}/api/auth/challenge`, { headers: { Accept: 'application/json' } });
  const chCookie = pickCookie(chRes.headers.get('set-cookie'));
  const chText = await chRes.text();
  const ch = parseJsonSafely(chText);
  if (!ch) {
    if (isMaintenanceResponse(chRes.status, chText)) {
      const err = new Error('Kintara API is under maintenance right now (503), so wallet login is temporarily unavailable.');
      err.code = 'MAINTENANCE';
      err.status = chRes.status;
      throw err;
    }
    if (isRetryable502(chRes.status, chText)) {
      const err = new Error(`challenge 502 gateway — origin down, retryable`);
      err.code = 'GATEWAY_502';
      err.status = 502;
      err.retryable = true;
      throw err;
    }
    throw new Error(`challenge returned non-JSON (status ${chRes.status}): ${chText.slice(0, 200)}`);
  }
  if (!ch?.ok || !ch.challengeId || !ch.message) throw buildAuthError('challenge', ch, chRes.status);

  const sig = nacl.sign.detached(Buffer.from(ch.message, 'utf8'), kp.secretKey);

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (chCookie) headers.Cookie = chCookie;
  const vRes = await fetch(`${API}/api/auth/verify`, {
    method: 'POST', headers,
    body: JSON.stringify({ publicKey, signature: Array.from(sig), message: ch.message, challengeId: ch.challengeId }),
  });
  const sessionCookie = pickCookie(vRes.headers.get('set-cookie')) || chCookie;
  const vText = await vRes.text();
  const data = parseJsonSafely(vText);
  if (!data) {
    if (isMaintenanceResponse(vRes.status, vText)) {
      const err = new Error('Kintara API is under maintenance right now (503), so wallet login is temporarily unavailable.');
      err.code = 'MAINTENANCE';
      err.status = vRes.status;
      throw err;
    }
    if (isRetryable502(vRes.status, vText)) {
      const err = new Error(`verify 502 gateway — origin down, retryable`);
      err.code = 'GATEWAY_502';
      err.status = 502;
      err.retryable = true;
      throw err;
    }
    throw new Error(`verify returned non-JSON (status ${vRes.status}): ${vText.slice(0, 200)}`);
  }
  if (!vRes.ok || !data?.ok) throw buildAuthError('verify', data, vRes.status);
  if (!sessionCookie) throw new Error('verify succeeded but no Set-Cookie kintara_session was returned');

  return { cookie: sessionCookie, player: data.player, raw: data };
}

/**
 * Complete login with retries for 502 responses and an anti-spam cooldown.
 * @returns {Promise<{cookie:string, player:object, raw:object}>}
 */
async function login(b58key = config.walletPrivateKey) {
  if (!b58key) throw new Error('WALLET_PRIVATE_KEY is not set in .env');
  const sinceLast = Date.now() - _lastLoginAttempt;
  if (sinceLast < LOGIN_COOLDOWN_MS) {
    await new Promise((r) => setTimeout(r, LOGIN_COOLDOWN_MS - sinceLast));
  }
  for (let attempt = 1; attempt <= LOGIN_RETRY_MAX; attempt++) {
    _lastLoginAttempt = Date.now();
    try {
      return await _loginOnce(b58key);
    } catch (e) {
      if (e.retryable && attempt < LOGIN_RETRY_MAX) {
        const wait = LOGIN_RETRY_BASE_MS * attempt + Math.floor(Math.random() * 3000);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

module.exports = { login, loadKeypair, isWalletBannedError };

// ---- CLI test ----
if (require.main === module) {
  login()
    .then((r) => { console.log('✅ LOGIN OK'); console.log('player:', JSON.stringify(r.player)); console.log('cookie:', r.cookie.slice(0, 40) + '... (len ' + r.cookie.length + ')'); })
    .catch((e) => { console.error('🛑 LOGIN FAILED:', e.message); process.exit(1); });
}
