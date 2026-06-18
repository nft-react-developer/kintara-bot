const state = { bots: [], selectedBot: '', selectedLog: '' };

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtAge(ms) {
  if (!ms) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function valueOrDash(value) {
  return value === null || value === undefined || value === '' ? '—' : value;
}

const STATUS_TOOLTIPS = {
  Active: 'Active means the recon data changed within the last 5 minutes.',
  Stale: 'Stale means recon data exists, but it has not changed for 5 to 30 minutes.',
  Offline: 'Offline means recon data exists, but it has not changed for more than 30 minutes.',
  Missing: 'Missing means the recon folder is not mounted or cannot be found.',
};

function metricLabel(label) {
  const tooltip = STATUS_TOOLTIPS[label];
  if (!tooltip) return `<span class="metric-label muted">${esc(label)}</span>`;
  return `
    <span class="metric-label muted">
      ${esc(label)}
      <span class="info-icon" tabindex="0" aria-label="${esc(label)} status help" data-tooltip="${esc(tooltip)}">i</span>
    </span>`;
}

function renderSummary(summary) {
  $('summary').innerHTML = [
    ['Total', summary.total],
    ['Active', summary.active],
    ['Stale', summary.stale],
    ['Offline', summary.offline],
    ['Missing', summary.missing],
  ].map(([label, value]) => `<div class="metric">${metricLabel(label)}<strong>${esc(value)}</strong></div>`).join('');
}

function renderBots(bots) {
  $('bots').innerHTML = bots.map((bot) => {
    const items = Object.entries(bot.inventory || {})
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `<span class="item">${esc(key)}: ${esc(value)}</span>`)
      .join('');
    return `
      <article class="card">
        <div class="card-head">
          <div><h3>${esc(bot.name)}</h3><p class="muted">${esc(bot.id)}</p></div>
          <span class="badge ${esc(bot.status)}">${esc(bot.status)}</span>
        </div>
        <div class="kv">
          <span>Player</span><b>${esc(valueOrDash(bot.playerName))}</b>
          <span>Activity</span><b>${esc(valueOrDash(bot.activity))}</b>
          <span>Avg level</span><b>${esc(valueOrDash(bot.levels?.avg))}</b>
          <span>Fishing XP</span><b>${esc(valueOrDash(bot.levels?.fishing))}</b>
          <span>Mining XP</span><b>${esc(valueOrDash(bot.levels?.mining))}</b>
          <span>Last seen</span><b>${fmtAge(bot.lastSeenMs)}</b>
        </div>
        <div class="items">${items || '<span class="muted">No item state yet</span>'}</div>
      </article>`;
  }).join('') || '<p class="muted">No bots configured. Add sources to server/dashboard-bots.json.</p>';
}

function renderLogSelectors() {
  const botSelect = $('botSelect');
  const logSelect = $('logSelect');
  botSelect.innerHTML = state.bots.map((bot) => `<option value="${esc(bot.id)}">${esc(bot.name)}</option>`).join('');
  const selectedBot = state.bots.find((bot) => bot.id === state.selectedBot) || state.bots[0];
  if (!selectedBot) {
    logSelect.innerHTML = '';
    $('logOutput').textContent = 'No bots configured.';
    return;
  }
  state.selectedBot = selectedBot.id;
  botSelect.value = state.selectedBot;
  const logs = selectedBot.logs || [];
  logSelect.innerHTML = logs.map((log) => `<option value="${esc(log.file)}">${esc(log.file)}</option>`).join('');
  if (!logs.some((log) => log.file === state.selectedLog)) state.selectedLog = logs[0]?.file || '';
  logSelect.value = state.selectedLog;
}

async function loadLogs() {
  if (!state.selectedBot || !state.selectedLog) {
    $('logOutput').textContent = 'No log file selected.';
    return;
  }
  const res = await fetch(`/api/bots/${encodeURIComponent(state.selectedBot)}/logs/${encodeURIComponent(state.selectedLog)}?lines=250`);
  $('logOutput').textContent = res.ok ? await res.text() : `Failed to load log: ${res.status}`;
}

async function refresh() {
  const res = await fetch('/api/summary');
  const summary = await res.json();
  state.bots = summary.bots || [];
  renderSummary(summary);
  renderBots(state.bots);
  renderLogSelectors();
  await loadLogs();
}

$('refreshBtn').addEventListener('click', refresh);
$('botSelect').addEventListener('change', (event) => { state.selectedBot = event.target.value; state.selectedLog = ''; renderLogSelectors(); loadLogs(); });
$('logSelect').addEventListener('change', (event) => { state.selectedLog = event.target.value; loadLogs(); });

refresh().catch((e) => { $('bots').innerHTML = `<p class="muted">Dashboard error: ${esc(e.message)}</p>`; });
setInterval(refresh, 5000);
