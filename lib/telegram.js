// ============ TELEGRAM CONTROL ============
// Zero-dependency Telegram bot client (long polling) — kirim notif & terima command.
const { config, persistEnv } = require('../config');

const TG_API = config.telegramToken ? `https://api.telegram.org/bot${config.telegramToken}` : null;

async function tgCall(method, body) {
  if (!TG_API) return null;
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.error('[telegram] error:', e.message);
    return null;
  }
}

async function send(text) {
  if (!config.telegramChatId) {
    console.log('[telegram:no-chat-id]', text);
    return;
  }
  return tgCall('sendMessage', {
    chat_id: config.telegramChatId,
    text,
    parse_mode: 'HTML',
  });
}

let offset = 0;

/**
 * Poll update terbaru & jalankan handler command.
 * @param {Record<string, (args: string[]) => Promise<string>|string>} commands - key tanpa '/'
 */
async function pollCommands(commands) {
  if (!TG_API) return;
  const res = await tgCall('getUpdates', { offset, timeout: 0 });
  if (!res?.ok) return;

  for (const update of res.result || []) {
    offset = update.update_id + 1;
    const msg = update.message;
    if (!msg?.text) continue;

    // Auto-capture chat id kalau belum diset
    if (!config.telegramChatId) {
      persistEnv('TELEGRAM_CHAT_ID', String(msg.chat.id));
      config.telegramChatId = String(msg.chat.id);
    }

    const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
    const cmd = cmdRaw.replace(/^\//, '').toLowerCase();

    const handler = commands[cmd];
    if (handler) {
      try {
        const reply = await handler(args);
        if (reply) await send(reply);
      } catch (e) {
        await send(`⚠️ Error menjalankan /${cmd}: ${e.message}`);
      }
    }
  }
}

module.exports = { send, pollCommands };
