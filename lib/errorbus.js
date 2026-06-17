// ============ ERROR BUS ============
// Records errors in errors.json with a stable signature and counter.
// Used by bots and modules to track repeated issues (expired cookie,
// rate limit, etc.) without noisy logs.
const fs = require('fs');
const path = require('path');

const ERRORS_PATH = path.join(__dirname, '..', 'errors.json');

function loadErrors() {
  try {
    return JSON.parse(fs.readFileSync(ERRORS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveErrors(data) {
  try {
    fs.writeFileSync(ERRORS_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[errorbus] failed to save errors.json:', e.message);
  }
}

function signatureOf({ code, context }) {
  return `${code || 'ERR'}::${context || 'unknown'}`;
}

/**
 * @param {object} opts
 * @param {string} opts.code - short error code, e.g. 'COOKIE_EXPIRED'
 * @param {string} opts.context - source module/function, e.g. 'marketplace.flip'
 * @param {string} [opts.message]
 */
function reportError({ code, context, message }) {
  const errors = loadErrors();
  const sig = signatureOf({ code, context });
  const now = new Date().toISOString();

  if (!errors[sig]) {
    errors[sig] = { code, context, count: 0, firstSeen: now, lastSeen: now, lastMessage: message };
  }
  errors[sig].count += 1;
  errors[sig].lastSeen = now;
  errors[sig].lastMessage = message;

  saveErrors(errors);
  return errors[sig];
}

function getErrors() {
  return loadErrors();
}

function clearErrors() {
  saveErrors({});
}

module.exports = { reportError, getErrors, clearErrors };
