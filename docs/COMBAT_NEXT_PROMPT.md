# PROMPT LANJUTAN — Combat Seed-Replication (paste ini)

Lanjut project kintara-farming-bot di `/root/TensorHash/kintara-farming-bot`. Recall memory `project_kintara_farming_bot.md` dulu. Sekarang fokus: **bangun combat-bot headless** untuk Wilderness hunting (combat XP + mount drops + daily-quest zombie).

## Konteks (yang SUDAH jalan & terbukti live, headless tanpa browser)
- Auth: `lib/walletAuth.js` (wallet sign → cookie). Presence WS: `lib/presenceWs.js` (queue `wss://kintara.gg/ws/queue/s2` → presence `wss://kintara.gg/ws/presence/s2`). Pos: `{t:'pos',region,x,y:0.25,z,ry,mov,act,...}`; coord world x=col-30.5, z=row-30.5 (Mainland 62×62). Realm transisi: walkTo portal + setRegion → region_ack.
- `harvestNode` (gather) PROVEN. `lib/bank.js depositAll` (bank Mainland world -24,-17.5) PROVEN = safety. Telegram `tools/telegram-bot.js` (/fish /gather /mine /auto /stop /status /skills /balance /quest). Orchestrator `tools/orchestrator.js`.
- Wilderness nav headless PROVEN: walk ke world(0.5,-30.5)=Mainland north portal → region=wild.

## BLOCKER combat (kenapa belum jadi)
Mob Wilderness **TIDAK dikirim server di snap** (snap keys: `[t,region,onlineTotal,players,npcs,npcHostId]` — gak ada `wildMobs` walau walk deep z-79.5, 1277 snap). Mob **di-spawn CLIENT-SIDE** via `createWildEnemies(THREE,scene,blockedTiles,srng,{cols,rows,offX,offZ,spawnCol,spawnRow})` di modul `./src/wildEnemies.js` (tersimpan di `recon/re/wildEnemies.js`, 1512 baris). Pakai **srng = xorshift fixed-seed `let _s=0xDEAD1337`** (shared/stateful, dipakai juga buat gen tree/rock SEBELUM mob). `presenceIsNpcHost()` true kalau `multiplayerNpcHostId==null` → kita host & generate mob lokal; snap `wildMobs` cuma ada kalau ada HOST LAIN.

## Protokol combat (sudah ke-RE)
- Hit mob: `presenceWs.send({t:'wm_ev', region:'wild'/'wild_ext'/'wild_exp', a:'hit', i:mobIndex, le:lifeEpoch, n:hitMult, psn:1(poison?), px:x, pz:z})`. Mob index `i` dari array mob.
- Server/host balas update mob state (HP), kill → combat XP + `wild_died{k:killerId}` saat mati. Butuh `wild_sword` equipped (ada di hotbar slot1). Const: WILD_SWORD_SWING_COOLDOWN_S, WILD_ENEMY_COUNT, PLAYER_WILD_STUN_S (di recon/re/constants.js + game.js).
- Mob: south=zombies, north=dragons (wildEnemies.js header). Eldergrove pakai `{t:'am_ev'}` (ayam, mungkin lebih aman).

## TUGAS sesi ini (urut)
1. **RE `recon/re/wildEnemies.js`**: cari fungsi spawn mob — gimana posisi (col,row) tiap mob dihitung dari `srng`. Cek apakah createWildEnemies pakai srng SENDIRI (seed terpisah, replikasi gampang) ATAU srng global shared (perlu replikasi urutan call gen tree→rock→mob, susah). Kalau ada `mulberry32`/seed lokal → port ke JS Node.
2. **Replikasi posisi mob** headless: port srng + spawn loop → daftar {i, col, row, type} mob. Validasi: bandingkan dgn mob asli (kalau bisa capture dari pemain host lain via snap.wildMobs).
3. **Build `tools/combat-bot.js`** dgn SURVIVAL ketat:
   - **BANK dulu** (`lib/bank.depositAll`) — wajib sebelum masuk wild (user udah pernah mati lose items).
   - Nav ke wild → walk ke mob terdekat (dari posisi replikasi) → `wm_ev` hit loop (hormati WILD_SWORD_SWING_COOLDOWN).
   - **Survival**: monitor HP (cari field HP — gak di /me; cek snap self-entry `players[].hp` atau msg lain), auto-consume potion (`client.consumePotion('potion_health')`, punya 5 each) saat HP low, RETREAT ke safe camp / Mainland saat HP kritis. **JANGAN sampai mati.**
   - Kill mob → combat XP. Loop. Wire `/combat` ke telegram.
4. **Test live SUPERVISED** (user diminta awasi run pertama). Bank-first = aman walau mati.

## Catatan
- 1 akun = 1 sesi presence (stop bot lain sebelum combat-bot, hindari konflik).
- Tiap tes = antri ~8-15 menit + server 502 intermittent. Pakai daemon persisten.
- Akun: pid 9285 ohmaygawd, avg lvl 8, wild_sword + potion 5 each ready. Wild realm juga ada coal (gather-bot bisa di wild).
- game.js: `curl -s https://kintara.gg/game.js` (4.4MB). Module: `https://kintara.gg/src/<name>.js`.
