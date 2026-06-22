const fs = require('fs');
const path = require('path');

function defaultMerchantWatcherState() {
  return {
    enabled: true,
    pausePending: false,
    cooldownUntil: 0,
    lastMode: null,
    lastStock: null,
    updatedAt: Date.now(),
  };
}

function readMerchantWatcherState(file) {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return { ...defaultMerchantWatcherState(), ...(saved && typeof saved === 'object' ? saved : {}) };
}

function writeMerchantWatcherState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...defaultMerchantWatcherState(), ...state, updatedAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

function createMerchantLogger(file, { now = () => new Date() } = {}) {
  return (event, details = null) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const suffix = details == null ? '' : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
    fs.appendFileSync(file, `[${now().toISOString()}] ${event}${suffix}\n`);
  };
}

function campaignSignature(campaign = {}) {
  return `${campaign.mode || 'unknown'}:${Number(campaign.goldStock) || 0}:${Number(campaign.goldStockFull) || 0}`;
}

function applyMerchantWatcherAction(state, action, { jobActive = false } = {}) {
  const current = { ...defaultMerchantWatcherState(), ...(state || {}) };
  if (action === 'activate') return { ...current, enabled: true, pausePending: false };
  if (action === 'pause') {
    return { ...current, enabled: jobActive, pausePending: jobActive };
  }
  if (action === 'refresh') return current;
  throw new Error(`unsupported merchant watcher action: ${action}`);
}

async function runMerchantWatcherTick({ state, jobActive = false, fetchSnapshot, startJob, log = () => {}, previousSignature = null }) {
  if (state.enabled === false || state.pausePending) return { skipped: 'paused', signature: previousSignature };
  if (jobActive) return { skipped: 'job_active', signature: previousSignature };
  if (Number(state.cooldownUntil) > Date.now()) return { skipped: 'daily_cap', signature: previousSignature };
  const snapshot = await fetchSnapshot();
  const signature = campaignSignature(snapshot.campaign);
  if (signature !== previousSignature) {
    log('campaign_state', {
      mode: snapshot.campaign?.mode || 'unknown',
      goldStock: Number(snapshot.campaign?.goldStock) || 0,
      goldStockFull: Number(snapshot.campaign?.goldStockFull) || 0,
    });
  }
  if (snapshot.maxTrades > 0) await startJob(snapshot);
  return { snapshot, signature, started: snapshot.maxTrades > 0 };
}

function createNonOverlappingPoller(task) {
  let inFlight = false;
  return async (...args) => {
    if (inFlight) return { skipped: 'in_flight' };
    inFlight = true;
    try {
      return await task(...args);
    } finally {
      inFlight = false;
    }
  };
}

module.exports = {
  defaultMerchantWatcherState,
  readMerchantWatcherState,
  writeMerchantWatcherState,
  createMerchantLogger,
  campaignSignature,
  applyMerchantWatcherAction,
  runMerchantWatcherTick,
  createNonOverlappingPoller,
};
