<div align="center">

# 🤖 Kintara Bot

### a **RY GROUP** project

Fully **headless** automation bot for [Kintara.gg](https://kintara.gg) — a Solana isometric MMO.
**No browser needed.** Login pakai wallet, kontrol penuh dari **Telegram**.

🎣 Fishing · 🍳 Cooking · 🪓 Woodcutting · ⛏ Mining (stone/coal) · 🏦 Banking · 💰 Marketplace · 📋 Daily Quest · 🧠 Auto-Orchestrator

[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

## ⚡ One-line Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kintara-bot/main/install.sh)
```

Installer otomatis: clone repo → install deps → minta **2 hal saja** (wallet private key + Telegram bot token) → tulis `.env` (chmod 600) → start bot kontrol Telegram.

**Non-interaktif:**
```bash
WALLET_PRIVATE_KEY=your_base58_key TELEGRAM_BOT_TOKEN=123456:AA... \
  bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kintara-bot/main/install.sh)
```

> 🔒 Private key kamu **tidak pernah keluar dari mesin** — hanya ditulis ke `.env` (chmod 600, git-ignored) untuk menandatangani login game secara lokal. **Cookie/session TIDAK diperlukan** — bot login sendiri dari private key.

## 📱 Kontrol via Telegram

Setelah install, buka bot Telegram kamu → `/start`:

| Command | Aksi |
|---------|------|
| `/fish` | 🎣 Fishing + auto-cooking |
| `/gather` | 🪓 Chop wood (woodcutting) |
| `/mine` | ⛏ Mining stone + coal |
| `/auto` | 🧠 Orchestrator pilih aktivitas otomatis |
| `/stop` | ⏹️ Stop semua bot |
| `/status` | 📊 Status + inventory live |
| `/skills` | 📈 Level & XP skill |
| `/balance` | 💰 Gold / $KINS / resource |
| `/quest` | 📋 Daily quest |
| `/help` | ❓ Daftar command |

> **1 akun = 1 aktivitas** (fishing **atau** gather) — lebih natural / aman anti-cheat.

## 🛠️ Cara Kerja (Headless, full reverse-engineered)

Bot bicara langsung ke protokol Kintara — **tanpa render game / browser**:

- **Auth**: `/api/auth/challenge` → tanda-tangan ed25519 (wallet) → `/api/auth/verify` → session (`lib/walletAuth.js`).
- **Realtime**: WebSocket presence (`wss://kintara.gg/ws/queue|presence`) — gerak (`pos`), region, snapshot, harvest (`lib/presenceWs.js`).
- **Aksi**: fishing (`act:fish` + grant-fish-xp), gather (`harv`/`harv_hit` + actionProof), cooking (Roast Pit), banking (`bankSlots`), marketplace (`/api/marketplace/sell`).

## 📋 Requirements

- Node.js ≥ 18
- Solana wallet (base58 private key) yang **hold ≥ 1.000 $KINS** (syarat main Kintara) + sudah **selesai tutorial** di game (unlock sell/quest).
- Telegram bot token ([@BotFather](https://t.me/BotFather)).

## 🧩 Manual run (tanpa Telegram)

```bash
npm install
cp .env.example .env   # isi WALLET_PRIVATE_KEY
npm run fish     # fishing+cooking
npm run gather   # wood
npm run mine     # stone/coal
npm run auto     # orchestrator
```

## ⚠️ Disclaimer

Automation tools bisa melanggar Terms of Service game. Pakai dengan risiko sendiri — project edukasi / riset. Combat (Wilderness mob) = **pending** (mob real-time client-sim, butuh game client — di luar scope headless).

---

<div align="center"><sub>RY GROUP · MIT License</sub></div>
