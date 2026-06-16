# CORE_LOOP_TODO.md

## Yang sudah confirmed (`kintara-api.md`)
- Auth/player state (`/api/auth/me`, player-stats)
- Backpack/inventory save
- Marketplace (listings, stats, token quote/buy)
- Daily quest progress/claim
- Casino (spinner free/paid, blackjack, roulette)
- World tribute & merchant campaign
- Bank unlock-page
- Friends/DM
- Token & server info

## Yang BELUM confirmed — perlu HAR capture baru

### 1. Login / Auth Flow (paling penting)
Cara capture:
1. Buka DevTools → tab **Network** → klik kanan → **"Save all as HAR with content"**.
2. Logout dari Kintara (kalau lagi login).
3. Klik "Connect Wallet" → pilih wallet → **approve signature request**.
4. Setelah masuk game, stop recording & save HAR.

Yang dicari di HAR:
- Endpoint yang return **nonce/challenge** untuk ditandatangani (mirip `POST /api/auth/challenge`)
- Endpoint **verify signature** yang return session cookie / JWT (mirip `POST /api/auth/verify`)
- Apakah ada **WebSocket handshake** (cek tab WS di Network) — kalau Kintara juga pakai socket.io
  seperti Owntown, ini krusial untuk movement & realtime actions.

### 2. Movement / Position Update
1. Record HAR.
2. Jalan-jalan beberapa langkah di game.
3. Stop & save.

Cari: request POST/WS message yang berisi `{realm, col, row}` atau delta posisi —
ini akan jadi dasar untuk auto-walk ke node resource.

### 3. Gathering Actions (chop wood / mining / fishing cast)
1. Record HAR.
2. Lakukan satu aksi chop kayu sampai dapat hasil (kayu masuk inventory).
3. Lakukan satu aksi mining (pickaxe ke rock node).
4. Lakukan satu aksi fishing cast → tunggu hasil → `grant-fish-xp` sudah confirmed,
   tapi **trigger aksi cast/reel-nya** belum.
5. Stop & save.

Cari pola: request dengan `nodeId`/`tileId`/`resourceType`, atau WS event seperti
`gathering:start` / `gathering:result` (kalau ada socket.io, cek tab WS → Messages).

### 4. Combat (Wilderness)
1. Record HAR.
2. Serang satu mob (`wild_zombie`/wolf) sampai mati, loot drop.
3. Stop & save.

Cari: request attack + response drop/loot, atau WS event `combat:attack`/`combat:result`.

### 5. Marketplace — Create Listing
Dokumen yang ada cuma punya GET listings & token-buy. Endpoint **jual/list item**
(`POST /api/marketplace/listings` atau sejenisnya) belum confirmed.
1. Record HAR → buat 1 listing baru dari inventory → save.

### 6. Bank Deposit/Withdraw
Endpoint spesifik deposit/withdraw OTWN-equivalent ($KINS atau gold ke bank) belum confirmed —
hanya `unlock-page`.
1. Record HAR → lakukan 1x deposit kecil → save.

## Analisa HAR (otomatis)
Begitu file `.har` siap, jalankan:
```bash
node tools/har-analyze.js path/ke/capture.har          # ringkasan request relevan + daftar WebSocket
node tools/har-analyze.js path/ke/capture.har --full    # semua request kintara + response body
```
Tool ini hanya baca file lokal (tidak request ke server), auto-redact cookie/token,
dan menandai request kandidat core-loop (move/gather/combat/listing/bank) + koneksi WS.

## Implementasi (SUDAH jadi — client-authoritative fabrication)
HAR mengonfirmasi: **0 WebSocket**, core loop client-authoritative. Tidak ada endpoint server
"chop/attack/move" — client PUSH state. Yang sudah dibangun:
- `lib/gameState.js` — `fetchState`/`fetchSkills`/`buildBackpackBody`/`pushBackpack`/`pushSkills`.
  Selalu baca `stateSeq` fresh → `baseSeq`; preserve seluruh backpack (anti-wipe); `intentionalRemovals:[]`.
- `modules/gathering.js` — `runGatherCycle` (woodcutting + mining), `computeGain` (rate manusiawi + cap).
- `modules/movement.js` — `moveTo` via `save-spawn` (+ `planPath`).
- `modules/combat.js` — `autoLoot` (ground-bags/loot-bag = jalur server asli).
- `tools/farm-probe.js` — probe verify-before-blast.

Semua dikunci di belakang `FABRICATE_ENABLED` (master) + per-fitur `GATHER_ENABLED`/`AUTOLOOT_ENABLED`,
default OFF. **Jalankan probe dulu** dengan cookie asli sebelum mengaktifkan gather massal.

### Masih butuh ACTION-HAR
- `grant-fish-xp` payload/response (fishing skill sementara via save-skills generik).
- Mekanik increment kill-count quest `wild_zombie` (`combat.killForQuest` masih `throw`).

## Cara kirim hasil ke saya
- Upload file `.har` (text/JSON, biasanya besar — kalau kepanjangan, filter dulu request
  yang ke `kintara.gg` / `ktra-server-b.onrender.com` aja, atau kompres jadi snippet
  request/response yang relevan).
- Atau cukup copy-paste: URL, method, request body, dan response body dari request yang relevan
  (hilangkan/redact cookie & token sebelum kirim).
