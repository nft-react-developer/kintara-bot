const MERCHANT_TRADE_COST = Object.freeze({
  wood: 2500,
  stone: 1500,
  coal: 700,
  cooked_fish_meat: 30,
});

const MERCHANT_RESOURCE_LABELS = Object.freeze({
  wood: 'Wood',
  stone: 'Stone',
  coal: 'Coal',
  cooked_fish_meat: 'Cooked fish',
});

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function merchantResourceSnapshot(backpack = {}) {
  return {
    wood: nonNegativeInt(backpack.wood),
    stone: nonNegativeInt(backpack.stone),
    coal: nonNegativeInt(backpack.coal),
    cooked_fish_meat: nonNegativeInt(backpack.cooked_fish_meat),
    gold: nonNegativeInt(backpack.gold),
  };
}

function normalizeMerchantCost(cost = MERCHANT_TRADE_COST) {
  const normalized = {};
  for (const type of Object.keys(MERCHANT_TRADE_COST)) {
    const amount = nonNegativeInt(cost[type]);
    if (amount <= 0) throw new Error(`invalid merchant cost for ${type}`);
    normalized[type] = amount;
  }
  return Object.freeze(normalized);
}

function parseMerchantTradeCostSource(source) {
  const text = String(source || '');
  const start = text.indexOf('const MERCHANT_TRADE_COST = [');
  if (start < 0) throw new Error('merchant trade cost not found in game client');
  const end = text.indexOf('\n];', start);
  if (end < 0) throw new Error('merchant trade cost is incomplete in game client');
  const block = text.slice(start, end);
  const cost = {};
  const row = /type:\s*['"](wood|stone|coal|cooked_fish_meat)['"][\s\S]*?amount:\s*(\d+)/g;
  let match;
  while ((match = row.exec(block))) cost[match[1]] = Number(match[2]);
  return normalizeMerchantCost(cost);
}

async function fetchMerchantTradeCost(apiBase, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${String(apiBase || '').replace(/\/$/, '')}/game.js?merchant=${Date.now()}`;
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/javascript', 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`game client request failed with status ${response?.status || '?'}`);
    return parseMerchantTradeCostSource(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

function merchantTradeEnabled(campaign = {}) {
  return campaign.goldTradeEnabled === true || campaign.mode === 'gold_trade';
}

function maxMerchantTrades(resources = {}, campaign = {}, cost = MERCHANT_TRADE_COST) {
  if (!merchantTradeEnabled(campaign)) return 0;
  const normalizedCost = normalizeMerchantCost(cost);
  const materialMax = Math.min(
    ...Object.keys(normalizedCost).map((type) => Math.floor(nonNegativeInt(resources[type]) / normalizedCost[type]))
  );
  const stock = campaign.goldStock == null ? Number.MAX_SAFE_INTEGER : nonNegativeInt(campaign.goldStock);
  return Math.max(0, Math.min(materialMax, stock));
}

function merchantWatcherButtons(state = {}) {
  const enabled = state.enabled !== false && !state.pausePending;
  return [
    [{
      text: enabled ? '\u23f8 Pause watcher' : '\u25b6\ufe0f Activate watcher',
      data: enabled ? 'mr:pause' : 'mr:activate',
    }],
    [{ text: '\ud83d\udd04 Refresh', data: 'mr:refresh' }],
  ];
}

function formatMerchantStatus({ state = {}, campaign = null, resources = null, cost = MERCHANT_TRADE_COST, maxTrades = 0, job = null, error = null } = {}) {
  const watcherStatus = state.pausePending ? 'Pause pending' : state.enabled === false ? 'Paused' : 'Active';
  const lines = [
    '\ud83e\uddd3 <b>Traveling Merchant</b>',
    `Watcher: <b>${watcherStatus}</b>`,
  ];
  if (campaign) {
    lines.push(
      `Merchant mode: <b>${String(campaign.mode || 'unknown')}</b>`,
      `Gold stock: <b>${nonNegativeInt(campaign.goldStock).toLocaleString('en-US')} / ${nonNegativeInt(campaign.goldStockFull).toLocaleString('en-US')}</b>`
    );
  } else {
    lines.push('Merchant mode: <b>unavailable</b>');
  }
  if (resources) {
    lines.push(
      '',
      '\ud83c\udf92 <b>Available materials</b>',
      `\ud83e\udeb5 Wood: <b>${nonNegativeInt(resources.wood).toLocaleString('en-US')}</b> / ${nonNegativeInt(cost.wood).toLocaleString('en-US')}`,
      `\ud83e\udea8 Stone: <b>${nonNegativeInt(resources.stone).toLocaleString('en-US')}</b> / ${nonNegativeInt(cost.stone).toLocaleString('en-US')}`,
      `\u26ab Coal: <b>${nonNegativeInt(resources.coal).toLocaleString('en-US')}</b> / ${nonNegativeInt(cost.coal).toLocaleString('en-US')}`,
      `\ud83c\udf73 Cooked fish: <b>${nonNegativeInt(resources.cooked_fish_meat).toLocaleString('en-US')}</b> / ${nonNegativeInt(cost.cooked_fish_meat).toLocaleString('en-US')}`,
      `Maximum trades now: <b>${nonNegativeInt(maxTrades)}</b>`
    );
  }
  if (job) {
    const resume = job.resumeLabel || job.resumeService || 'Idle';
    lines.push('', `Operation: <b>${job.phase || 'running'}</b>`, `Resume afterward: <b>${resume}</b>`);
  } else {
    lines.push('', 'Operation: <b>Idle</b>');
  }
  if (state.cooldownUntil > Date.now()) {
    lines.push(`Next watcher attempt: <b>${new Date(state.cooldownUntil).toISOString()}</b>`);
  }
  if (error) lines.push('', `\u26a0\ufe0f Live refresh failed: <code>${escapeHtml(String(error).slice(0, 140))}</code>`);
  return lines.join('\n');
}

module.exports = {
  MERCHANT_TRADE_COST,
  MERCHANT_RESOURCE_LABELS,
  merchantResourceSnapshot,
  normalizeMerchantCost,
  parseMerchantTradeCostSource,
  fetchMerchantTradeCost,
  merchantTradeEnabled,
  maxMerchantTrades,
  merchantWatcherButtons,
  formatMerchantStatus,
};
