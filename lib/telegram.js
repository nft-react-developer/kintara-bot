// ============ TELEGRAM CONTROL ============
// Zero-dependency Telegram bot client (long polling) — sends notifications and receives commands.
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
 * Poll latest updates and run the command handler.
 * @param {Record<string, (args: string[]) => Promise<string>|string>} commands - key without '/'
 */
async function pollCommands(commands) {
  if (!TG_API) return;
  const res = await tgCall('getUpdates', { offset, timeout: 0 });
  if (!res?.ok) return;

  for (const update of res.result || []) {
    offset = update.update_id + 1;
    const msg = update.message;
    if (!msg?.text) continue;

    const chatId = String(msg.chat.id);
    if (config.telegramChatId && chatId !== String(config.telegramChatId)) continue;

    // Auto-capture chat ID when it is not set yet
    if (!config.telegramChatId) {
      persistEnv('TELEGRAM_CHAT_ID', chatId);
      config.telegramChatId = chatId;
    }

    const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
    const cmd = cmdRaw.replace(/^\//, '').toLowerCase();

    const handler = commands[cmd];
    if (handler) {
      try {
        const reply = await handler(args);
        if (reply) await send(reply);
      } catch (e) {
        await send(`⚠️ Error running /${cmd}: ${e.message}`);
      }
    }
  }
}

module.exports = { send, pollCommands };
