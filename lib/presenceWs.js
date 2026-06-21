// ============ PRESENCE WS — client headless (Path A, no browser) ============
// Replicates the game client connection:
//   1) login wallet -> cookie kintara_session
//   2) connect to wss://kintara.gg/ws/queue/<shard>, send {t:q_ping} until {t:queue_ready}
//   3) connect to wss://kintara.gg/ws/presence/<shard>, send {t:pos,...}
// Set region via pos -> server replies with {t:region_ack}. This gates region actions like fishing.
const WebSocket = require('ws');
const EventEmitter = require('events');
const { login } = require('./walletAuth');
const { config } = require('../config');

const HOST = 'kintara.gg';

function shardList(primary, fallbacks) {
  const seen = new Set();
  return [primary, ...(String(fallbacks || '').split(','))]
    .map((s) => String(s || '').trim())
    .filter((s) => s && !seen.has(s) && seen.add(s));
}

function isShardRejectedError(error) {
  return /Unexpected server response:\s*403/i.test(error?.message || '');
}

function playerIdsEqual(left, right) {
  if (left == null || right == null) return false;
  const leftId = Number(left);
  const rightId = Number(right);
  return Number.isFinite(leftId) && Number.isFinite(rightId) && leftId === rightId;
}

class Presence extends EventEmitter {
  constructor(shard = config.shard || 's4', { synchronizeSelf = false } = {}) {
    super();
    this.shards = shardList(shard, config.shardFallbacks);
    this.shard = this.shards[0] || 's2';
    this.cookie = null;
    this.queueWs = null;
    this.presenceWs = null;
    this.ready = false;
    this.synchronizeSelf = !!synchronizeSelf;
    this.region = this.synchronizeSelf ? null : 'world';
    this.pos = this.synchronizeSelf
      ? { x: null, y: null, z: null, ry: 0 }
      : { x: 8.5, y: 0.25, z: 13.5, ry: 0 };
    this.selfState = null;
    this.selfStateVersion = 0;
    this._qping = null;
    this._posTimer = null;
    // combat / survival state
    this.eq = null;            // equipped item type (wild_sword for combat)
    this.hp = 100;             // server-authoritative, updated from wild_mb_ack/snap self-entry
    this.shield = 0;           // shield charges (0-5), from potion_shield
    this.lifeEpoch = 0;        // latest server life epoch, echoed in pos/wm_ev
    this.wildMobs = [];        // [{i,d,lv,x,z,ry,col,row,alive}] from snap.npcs.wildMobs
    this._mobsAt = 0;          // timestamp snap mob terakhir
  }

  log(...a) { this.emit('log', a.join(' ')); }

  /**
   * Connect to the queue and then presence. If a cookie was injected externally
   * through setCookie/the constructor, SKIP login to save two round trips and reduce
   * rate-limit/ban risk. Log in only when no cookie is available.
   */
  async connect() {
    if (!this.cookie) {
      const auth = await login();
      this.cookie = auth.cookie;
      this.player = auth.player;
      this.myId = auth.player?.id;
      this.log('walletAuth ok pid=' + auth.player?.id);
    } else {
      this.log('reuse existing cookie pid=' + (this.myId || '?'));
    }
    await this._queue();
  }

  /** Inject an external cookie and player (KintaraClient) so connect() does not log in again. */
  setCookie(cookie, player) {
    this.cookie = cookie;
    if (player) { this.player = player; this.myId = player.id; }
  }

  /** Seed an authoritative position loaded from the persisted player spawn. */
  seedSelfState({ region, x, y = 0.25, z, ry = 0 } = {}) {
    const px = Number(x);
    const py = Number(y);
    const pz = Number(z);
    const pry = Number(ry);
    if (!region || !Number.isFinite(px) || !Number.isFinite(pz)) {
      throw new Error('invalid authoritative self state seed');
    }
    this.region = String(region);
    this.pos = {
      x: px,
      y: Number.isFinite(py) ? py : 0.25,
      z: pz,
      ry: Number.isFinite(pry) ? pry : 0,
    };
    this.selfStateVersion++;
    this.selfState = { region: this.region, ...this.pos, version: this.selfStateVersion };
    return { ...this.selfState };
  }

  _wsOpts() { return { headers: { Cookie: this.cookie, Origin: 'https://kintara.gg' } }; }

  _closeQueueSocket() {
    clearInterval(this._qping);
    if (!this.queueWs) return;
    try { this.queueWs.terminate(); } catch {}
    this.queueWs = null;
  }

  _queue() {
    return new Promise((resolve, reject) => {
      const url = `wss://${HOST}/ws/queue/${this.shard}`;
      if (this._closing) return reject(new Error('presence client is closing'));
      this.log('connect queue ' + url);
      const ws = new WebSocket(url, this._wsOpts());
      this.queueWs = ws;
      const to = setTimeout(() => reject(new Error('queue connect timeout')), 20000);
      ws.on('open', () => { clearTimeout(to); this.log('queue open'); this._qping = setInterval(() => { try { ws.send(JSON.stringify({ t: 'q_ping' })); } catch {} }, 5000); ws.send(JSON.stringify({ t: 'q_ping' })); });
      ws.on('message', (buf) => {
        let d; try { d = JSON.parse(buf.toString()); } catch { return; }
        if (d.t === 'queue_pos') this.emit('queue', d);
        else if (d.t === 'queue_ready') { this.log('queue_ready -> presence'); clearInterval(this._qping); try { ws.close(); } catch {} this._presence().then(resolve).catch(reject); }
      });
      ws.on('error', (e) => { clearTimeout(to); if (!this._closing) reject(new Error('queue ws err: ' + e.message)); });
      ws.on('close', () => { clearInterval(this._qping); });
    });
  }

  _presence() {
    return new Promise((resolve, reject) => {
      const url = `wss://${HOST}/ws/presence/${this.shard}`;
      if (this._closing) return reject(new Error('presence client is closing'));
      this.log('connect presence ' + url);
      const ws = new WebSocket(url, this._wsOpts());
      this.presenceWs = ws;
      const to = setTimeout(() => reject(new Error('presence connect timeout')), 20000);
      ws.on('open', () => {
        clearTimeout(to); this.ready = true; this.log('presence open');
        if (!this.synchronizeSelf || this.selfState) {
          if (this.synchronizeSelf) this.log(`using persisted self state region=${this.region} x=${this.pos.x} z=${this.pos.z}`);
          this._sendPos(true);
        } else this.log('waiting for authoritative self state');
        this._posTimer = setInterval(() => this._sendPos(false), 3000); // position heartbeat
        resolve();
      });
      ws.on('message', (buf) => {
        let d; try { d = JSON.parse(buf.toString()); } catch { return; }
        this.emit('msg', d);
        this._trackLifeEpoch(d);
        if (d.t === 'region_ack') { this.region = d.region; this.emit('region_ack', d); }
        else if (d.t === 'snap') { this._onSnap(d); this.emit('snap', d); }
        else if (d.t === 'res_evt') { this._onResEvt(d); this.emit('res_evt', d); }
        else if (d.t === 'res_snap') this.emit('res_snap', d);
        else if (d.t === 'harv_full') this.emit('harv_full', d);
        else if (d.t === 'wild_mb_ack') this._onWildMbAck(d);
        else if (d.t === 'pvit') this._onPvit(d);
        else if (d.t === 'skill_xp' && d.xp) { this.skillXp = d.xp; this.emit('skill_xp', d.xp); }
        else if (d.t === 'wm_ev' && d.a === 'hit' && Number(d.by) === Number(this.myId)) this.emit('wm_kill', d);
      });
      ws.on('error', (e) => { clearTimeout(to); if (!this._closing) reject(new Error('presence ws err: ' + e.message)); });
      ws.on('close', () => { clearInterval(this._posTimer); this.ready = false; if (!this._closing) this.emit('close'); });
    });
  }

  _sendPos(full) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    if (!this.region || !Number.isFinite(Number(this.pos?.x)) || !Number.isFinite(Number(this.pos?.z))) return;
    const base = { t: 'pos', region: this.region, x: this.pos.x, y: Number.isFinite(Number(this.pos.y)) ? Number(this.pos.y) : 0.25, z: this.pos.z, ry: this.pos.ry, mov: false, le: this.lifeEpoch || 0, tut: 18 };
    if (full) base.outfit = { outfitSchema: 15, hat: 0, top: 0, pants: 0, shoe: 0, skinTone: 1 };
    // gather action (chop/mine/fish) — server needs this to gate grant-*-xp
    if (this.act) { base.act = this.act; if (this.act === 'fish') { base.fc = this.fishCastCol; base.fr = this.fishCastRow; base.fph = this.fishPhase; } }
    // equipped item (presence visual + server context). wild_sword is required for combat.
    if (this.eq) base.eq = this.eq;
    // wild realm: HP + shield + spawn-protect + blocked-tile manifest, needed by the hub for mob spawn/pathing
    if (/^wild/.test(this.region)) {
      base.php = Math.max(0, Math.min(100, this.hp | 0));
      base.wsh = Math.max(0, Math.min(5, this.shield | 0));
      base.wsp = 0;
      if (this.pendingWblk) { base.wblk = this.pendingWblk; this.pendingWblk = null; }
    }
    // wild blocked-tile manifest non-wild path (legacy harvest hosting)
    else if (this.pendingWblk) { base.wblk = this.pendingWblk; this.pendingWblk = null; }
    try { this.presenceWs.send(JSON.stringify(base)); } catch {}
  }

  /** Set fishing action in pos (act='fish' + cast tile + phase). Pond tile col/row. */
  setFishing(castCol, castRow, phase) { this.act = 'fish'; this.fishCastCol = castCol; this.fishCastRow = castRow; this.fishPhase = phase; this._sendPos(false); }
  setAct(a) { this.act = a || null; this._sendPos(false); }
  /** Send wild blocked-tile manifest to the hub (host) -> hub spawns/paths mobs. tiles=['col,row',...] */
  sendWildManifest(tiles) { this.pendingWblk = Array.isArray(tiles) ? tiles.map(String) : null; this._sendPos(false); }

  // ===== COMBAT (Wilderness) =====
  // Server-authoritative mobs: hub broadcasts position+HP in snap.npcs.wildMobs.
  // Coord wild: world x=col-24.5, z=row-24.5 (WILD 50x50, off=-24.5).
  static WILD_OFF = -24.5;

  /** Track life epoch from server messages (snap/ack carry le). Echo it back in pos+wm_ev. */
  _trackLifeEpoch(d) {
    const le = d && d.le != null && Number.isFinite(Number(d.le)) ? Number(d.le) | 0 : null;
    if (le != null && le > (this.lifeEpoch | 0)) this.lifeEpoch = le;
  }

  /** Parse snap: extract wildMobs (nested under npcs) + self HP. */
  _onSnap(d) {
    // Synchronize the local player before the authoritative mode sends any position.
    if (Array.isArray(d.players) && this.myId != null) {
      const self = d.players.find((p) => Number(p.id) === Number(this.myId));
      if (self) {
        if (self.php != null && Number.isFinite(Number(self.php))) this.hp = Number(self.php) | 0;
        const x = self.x == null ? NaN : Number(self.x);
        const z = self.z == null ? NaN : Number(self.z);
        const y = Number(self.y);
        const ry = Number(self.ry);
        const region = self.pr || self.region || d.region || this.region;
        const regionChanged = !!(region && region !== this.region);
        if (region && Number.isFinite(x) && Number.isFinite(z) && (!this._walking || regionChanged)) {
          this.region = region;
          this.pos = {
            x,
            y: Number.isFinite(y) ? y : (this.pos?.y ?? 0.25),
            z,
            ry: Number.isFinite(ry) ? ry : (this.pos?.ry || 0),
          };
          this.selfStateVersion++;
          this.selfState = { region: this.region, ...this.pos, version: this.selfStateVersion };
          this.emit('self_state', this.selfState);
        }
      }
    }
    // wildMobs is nested under npcs; older recon checked the top level and missed this
    const npcs = d.npcs && typeof d.npcs === 'object' ? d.npcs : null;
    const arr = npcs && Array.isArray(npcs.wildMobs) ? npcs.wildMobs : null;
    if (arr && /^wild/.test(this.region)) {
      const OFF = Presence.WILD_OFF;
      this.wildMobs = arr.map((m, i) => {
        const lv = Number(m.lv) | 0;
        const x = Number(m.x), z = Number(m.z);
        return {
          i, d: Number(m.d) === 1 ? 1 : 0, lv, alive: lv > 0,
          x: Number.isFinite(x) ? x : null, z: Number.isFinite(z) ? z : null,
          col: Number.isFinite(x) ? Math.round(x - OFF) : null,
          row: Number.isFinite(z) ? Math.round(z - OFF) : null,
          st: Number(m.st) || 0,
        };
      });
      this._mobsAt = Date.now();
      this.emit('mobs', this.wildMobs);
    }
  }

  /** Wait until a snapshot contains this player's authoritative region and position. */
  waitForSelfState({ timeoutMs = 15000, region = null, afterVersion = 0 } = {}) {
    const matches = (state) => state
      && state.version > afterVersion
      && (!region || state.region === region)
      && Number.isFinite(Number(state.x))
      && Number.isFinite(Number(state.z));
    if (matches(this.selfState)) return Promise.resolve({ ...this.selfState });
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('self_state', onState);
        this.removeListener('close', onClose);
      };
      const onState = (state) => {
        if (!matches(state)) return;
        cleanup();
        resolve({ ...state });
      };
      const onClose = () => {
        cleanup();
        reject(new Error('presence closed before self state synchronized'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`self state synchronization timeout${region ? ` for region ${region}` : ''}`));
      }, timeoutMs);
      this.on('self_state', onState);
      this.on('close', onClose);
    });
  }

  /** Wait for a region acknowledgement or authoritative snapshot. */
  waitForRegion(region, timeoutMs = 10000) {
    if (this.region === region) return Promise.resolve(region);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('region_ack', onRegion);
        this.removeListener('self_state', onState);
        this.removeListener('close', onClose);
      };
      const finish = (nextRegion) => {
        if (nextRegion !== region) return;
        cleanup();
        resolve(region);
      };
      const onRegion = (message) => finish(message?.region);
      const onState = (state) => finish(state?.region);
      const onClose = () => { cleanup(); reject(new Error(`presence closed before entering ${region}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`region transition timeout: ${region}`)); }, timeoutMs);
      this.on('region_ack', onRegion);
      this.on('self_state', onState);
      this.on('close', onClose);
    });
  }

  /** Wait for a future server confirmation; unlike waitForRegion, local state is ignored. */
  waitForRegionConfirmation(region, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('region_ack', onRegion);
        this.removeListener('self_state', onState);
        this.removeListener('close', onClose);
      };
      const finish = (confirmedRegion) => {
        if (confirmedRegion !== region) return;
        cleanup();
        resolve(region);
      };
      const onRegion = (message) => finish(message?.region);
      const onState = (state) => finish(state?.region);
      const onClose = () => { cleanup(); reject(new Error(`presence closed before confirming ${region}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`region confirmation timeout: ${region}`)); }, timeoutMs);
      this.on('region_ack', onRegion);
      this.on('self_state', onState);
      this.on('close', onClose);
    });
  }

  /** wild_mb_ack: hub replies with HP/shield after contact reports (wmb). We do not send wmb,
   *  but still update HP if the server pushes it as a defense-in-depth path. */
  _onWildMbAck(d) {
    if (d.php != null && Number.isFinite(Number(d.php))) { this.hp = Number(d.php) | 0; this.emit('hp', this.hp); }
    if (d.wsh != null && Number.isFinite(Number(d.wsh))) this.shield = Number(d.wsh) | 0;
    if (this.hp <= 0) this.emit('died', d);
  }

  /** pvit broadcast — usually remote, but consume HP when pid==us. */
  _onPvit(d) {
    if (Number(d.pid) === Number(this.myId)) {
      if (d.php != null && Number.isFinite(Number(d.php))) { this.hp = Number(d.php) | 0; this.emit('hp', this.hp); }
      if (d.wsh != null && Number.isFinite(Number(d.wsh))) this.shield = Number(d.wsh) | 0;
      if (this.hp <= 0) this.emit('died', d);
    }
  }

  /** Equip weapon (broadcast eq in pos). 'wild_sword' is required for wm_ev. */
  equip(itemType) { this.eq = itemType || null; this._sendPos(false); }

  /** Wild tile col/row from the current position. */
  wildTile() { return { col: Math.round(this.pos.x - Presence.WILD_OFF), row: Math.round(this.pos.z - Presence.WILD_OFF) }; }

  /** Nearest live mob from the current position (Chebyshev tile distance). null when none exist. */
  nearestMob() {
    const me = this.wildTile();
    let best = null, bestD = Infinity;
    for (const m of this.wildMobs) {
      if (!m.alive || m.col == null) continue;
      const dd = Math.max(Math.abs(m.col - me.col), Math.abs(m.row - me.row));
      if (dd < bestD) { bestD = dd; best = m; }
    }
    return best ? { ...best, cheb: bestD } : null;
  }

  /** Send hit to mob index i. n=hitMult (1 base, 2 L2, +1 strength). Caller owns cooldown. */
  sendWildMobHit(i, n = 1) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return false;
    if (!/^wild/.test(this.region)) return false;
    const msg = { t: 'wm_ev', region: this.region, a: 'hit', i: i | 0, le: this.lifeEpoch | 0, px: this.pos.x, pz: this.pos.z };
    if (n > 1) msg.n = n | 0;
    try { this.presenceWs.send(JSON.stringify(msg)); return true; } catch { return false; }
  }


  // ===== GATHER (harvest) =====
  // Learn node locations from res_evt broadcasts (tile key + kind + actionProof).
  _onResEvt(d) {
    if (!this.nodes) this.nodes = new Map();
    for (const k of (d.keys || [])) {
      const cur = this.nodes.get(k) || {};
      this.nodes.set(k, { kind: d.kind, hasCoal: !!d.hasCoal, hasMetal: !!d.hasMetal, lastProof: d.actionProof || cur.lastProof, seen: Date.now() });
    }
    // proof for the node we harvested
    if (playerIdsEqual(d.by, this.myId) && d.actionProof) { this._lastMyProof = { keys: d.keys, proof: d.actionProof }; }
  }
  /** Current node list by kind (from res_evt). */
  knownNodes(kind) { return [...(this.nodes || new Map()).entries()].filter(([, v]) => v.kind === kind).map(([k, v]) => ({ key: k, ...v })); }

  /** Start harvesting a node; server replies with actionProof for this node. keys=['col,row']. */
  sendHarv(kind, keys, hasCoal = false) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const uniq = [...new Set(keys.map(String))].sort();
    try { this.presenceWs.send(JSON.stringify({ t: 'harv', region: this.region, k: kind, keys: uniq, hasCoal })); } catch {}
  }
  /** Harvest 1 full node (event-driven): harv -> each res_evt refreshes proof+h -> harv_hit until felled. */
  async harvestNode(kind, key, hasCoal = false, hasMetal = false, { maxHits = 10, hitGap = 1700 } = {}) {
    this.setAct(kind === 'tree' ? 'chop' : 'mine');
    let h = 0, hm = 99, lastProof = '', loot = null, hits = 0;
    const onEvt = (d) => { if (playerIdsEqual(d.by, this.myId) && (d.keys || []).includes(key)) { h = d.h; hm = d.hm; if (d.actionProof) lastProof = d.actionProof; loot = d.loot; } };
    this.on('res_evt', onEvt);
    this.sendHarv(kind, [key], hasCoal);
    for (let i = 0; i < maxHits; i++) {
      await new Promise((r) => setTimeout(r, hitGap));
      if (hm < 99 && h >= hm) break; // felled
      this.sendHarvHit(kind, [key], hasCoal, hasMetal, lastProof); hits++;
    }
    await new Promise((r) => setTimeout(r, 800));
    this.removeListener('res_evt', onEvt); this.clearAct();
    return { felled: hm < 99 && h >= hm, h, hm, hits, loot };
  }

  /** Harvest hit; echoes the actionProof obtained from snap/res_evt for this node. */
  sendHarvHit(kind, keys, hasCoal, hasMetal, actionProof) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const uniq = [...new Set(keys.map(String))].sort();
    const payload = { t: 'harv_hit', region: this.region, k: kind, keys: uniq, hasCoal: !!hasCoal, hasMetal: !!hasMetal };
    if (actionProof) payload.actionProof = actionProof;
    try { this.presenceWs.send(JSON.stringify(payload)); } catch {}
  }
  clearAct() { this.act = null; this._sendPos(false); }
  /** Convert world x/z -> tile col/row for the active realm (pond offset=-19.5). */
  pondTile() { return { col: Math.round(this.pos.x + 19.5), row: Math.round(this.pos.z + 19.5) }; }

  /** Change realm + position. Server replies with region_ack. */
  setRegion(region, x, z, y = null) { this.region = region; if (x != null) this.pos.x = x; if (z != null) this.pos.z = z; if (y != null) this.pos.y = y; this._sendPos(true); }
  moveTo(x, z) { this.pos.x = x; this.pos.z = z; this._sendPos(false); }

  _sendPosMoving() {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const m = { t: 'pos', region: this.region, x: this.pos.x, y: Number.isFinite(Number(this.pos.y)) ? Number(this.pos.y) : 0.25, z: this.pos.z, ry: this.pos.ry, mov: true, le: this.lifeEpoch || 0, tut: 18 };
    if (this.eq) m.eq = this.eq;
    if (/^wild/.test(this.region)) {
      m.php = Math.max(0, Math.min(100, this.hp | 0));
      m.wsh = Math.max(0, Math.min(5, this.shield | 0));
      m.wsp = 0;
      if (this.pendingWblk) { m.wblk = this.pendingWblk; this.pendingWblk = null; }
    }
    try { this.presenceWs.send(JSON.stringify(m)); } catch {}
  }

  /** Walk realistically to (tx,tz) in world coords, sending pos at MOVE_SPEED. Stops when until() returns true. */
  async walkTo(tx, tz, { speed = 3.5, dt = 0.15, until = null, maxSec = 30 } = {}) {
    if (!this.region || !Number.isFinite(Number(this.pos?.x)) || !Number.isFinite(Number(this.pos?.z))) {
      throw new Error('cannot walk before self position is synchronized');
    }
    this._walking = true;
    try {
      const t0 = Date.now();
      for (;;) {
        const dx = tx - this.pos.x, dz = tz - this.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.4) break;
        if (until && until()) return 'until';
        if ((Date.now() - t0) / 1000 > maxSec) return 'timeout';
        const move = Math.min(dist, speed * dt);
        this.pos.x += (dx / dist) * move;
        this.pos.z += (dz / dist) * move;
        this.pos.ry = Math.atan2(dx, dz);
        this._sendPosMoving();
        await new Promise((r) => setTimeout(r, dt * 1000));
      }
      this.pos.x = tx; this.pos.z = tz; this._sendPos(false);
      return 'arrived';
    } finally {
      this._walking = false;
    }
  }
  close() {
    this._closing = true;
    this.ready = false;
    clearInterval(this._qping);
    clearInterval(this._posTimer);
    for (const ws of [this.presenceWs, this.queueWs]) {
      if (!ws) continue;
      try { ws.close(); } catch {}
      if (ws.readyState === WebSocket.CONNECTING) {
        try { ws.terminate(); } catch {}
      }
    }
  }
}

module.exports = { Presence };

// ---- CLI smoke test: connect, enter, wait for region_ack + sample snap ----
if (require.main === module) {
  const p = new Presence(process.argv[2] || config.shard || 's4');
  p.on('log', (m) => console.log('[ws]', m));
  p.on('queue', (d) => process.stdout.write(`queue ahead=${d.ahead}  \r`));
  p.on('region_ack', (d) => console.log('\n✅ region_ack:', d.region));
  let snaps = 0; p.on('snap', (d) => { if (snaps++ === 0) console.log('snap: region=' + d.region + ' online=' + d.onlineTotal + ' players=' + (d.players?.length)); });
  p.connect()
    .then(() => { console.log('✅ PRESENCE LIVE region=' + p.region + ' pos=', p.pos); setTimeout(() => { console.log('done sample'); p.close(); process.exit(0); }, 12000); })
    .catch((e) => { console.error('🛑', e.message); process.exit(1); });
}
