// ============ TELEGRAM CONTROL ============
// Zero-dependency Telegram bot client (long polling) — sends notifications, commands,
// inline buttons (callback_query), and multi-step text input (sell/buy sessions).
const fs = require('fs');
const path = require('path');
const { config, persistEnv } = require('../config');

const TG_API = config.telegramToken ? `https://api.telegram.org/bot${config.telegramToken}` : null;
const STATE_DIR = path.join(__dirname, '..', 'recon', 'control');
const OFFSET_PATH = path.join(STATE_DIR, 'telegram-offset.json');

function loadOffset() {
  try {
    return JSON.parse(fs.readFileSync(OFFSET_PATH, 'utf8')).offset || 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(OFFSET_PATH, JSON.stringify({ offset }));
  } catch (e) {
    console.error('[telegram] failed to save offset:', e.message);
  }
}

function isAuthorizedChat(idLike) {
  const chatId = String(idLike || '');
  if (!chatId) return false;
  if (!config.telegramChatId) {
    persistEnv('TELEGRAM_CHAT_ID', chatId);
    config.telegramChatId = chatId;
    return true;
  }
  return chatId === String(config.telegramChatId);
}

async function tgCall(method, body) {
  if (!TG_API) return null;
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json?.ok) {
      console.error(`[telegram:${method}] api error:`, json?.description || 'unknown error');
    }
    return json;
  } catch (e) {
    console.error('[telegram] error:', e.message);
    return null;
  }
}

function toPlainTelegramText(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

// Send a message. opts.buttons = array of rows; each row is {text,data}|{text,url}.
async function send(text, opts = {}) {
  if (!config.telegramChatId) {
    console.log('[telegram:no-chat-id]', text);
    return;
  }
  const body = {
    chat_id: config.telegramChatId,
    text: String(text || ''),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const kb = buildKeyboard(opts.buttons);
  if (kb) body.reply_markup = kb;
  const res = await tgCall('sendMessage', body);
  if (res?.ok || body.parse_mode !== 'HTML') return res;

  // Fallback: if HTML entities are broken, for example server errors containing <!doctype>,
  // resend as plain text so the command does not fail silently.
  const fallback = {
    ...body,
    text: toPlainTelegramText(text),
  };
  delete fallback.parse_mode;
  return tgCall('sendMessage', fallback);
}

function buildKeyboard(buttons) {
  if (!Array.isArray(buttons) || !buttons.length) return null;
  const inline_keyboard = buttons
    .map((row) => (Array.isArray(row) ? row : [row]))
    .map((row) =>
      row.map((b) => {
        const btn = { text: String(b.text) };
        if (b.url) btn.url = b.url;
        else btn.callback_data = String(b.data).slice(0, 64); // TG limit 64 byte
        return btn;
      })
    );
  return { inline_keyboard };
}

async function editMessage(chatId, messageId, text, opts = {}) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: String(text || ''),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const kb = buildKeyboard(opts.buttons);
  body.reply_markup = kb || { inline_keyboard: [] };
  const res = await tgCall('editMessageText', body);
  if (res?.ok || body.parse_mode !== 'HTML') return res;

  const fallback = {
    ...body,
    text: toPlainTelegramText(text),
  };
  delete fallback.parse_mode;
  return tgCall('editMessageText', fallback);
}

async function answerCallback(callbackId, text) {
  return tgCall('answerCallbackQuery', { callback_query_id: callbackId, text: text || '' });
}

let offset = loadOffset();

/**
 * Poll the latest updates. Supports:
 *  - commands: map { cmd: (args)=>string }  (text /cmd)
 *  - opts.onCallback(data, ctx)  -> handle inline button. ctx = {chatId,messageId,callbackId}
 *  - opts.onText(text, ctx)      -> handle plain text messages for multi-step input.
 *                                   return truthy when consumed, which skips command parsing.
 */
async function pollCommands(commands, opts = {}) {
  if (!TG_API) return;
  const res = await tgCall('getUpdates', { offset, timeout: 1, allowed_updates: ['message', 'callback_query'] });
  if (!res?.ok) return;

  for (const update of res.result || []) {
    offset = update.update_id + 1;
    saveOffset(offset);

    // ---- callback_query (inline button click) ----
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      if (!isAuthorizedChat(chatId)) { await answerCallback(cq.id); continue; }
      const ctx = { chatId, messageId: cq.message?.message_id, callbackId: cq.id };
      try {
        if (typeof opts.onCallback === 'function') await opts.onCallback(String(cq.data || ''), ctx);
        await answerCallback(cq.id);
      } catch (e) {
        await answerCallback(cq.id, 'Error');
        await send(`⚠️ Button error: ${e.message}`);
      }
      continue;
    }

    const msg = update.message;
    if (!msg?.text) continue;
    if (!isAuthorizedChat(msg?.chat?.id)) continue;

    const text = msg.text.trim();
    const ctx = { chatId: msg.chat.id, messageId: msg.message_id };

    // ---- multi-step text input (sell/buy session) ----
    if (!text.startsWith('/') && typeof opts.onText === 'function') {
      try {
        const consumed = await opts.onText(text, ctx);
        if (consumed) continue;
      } catch (e) {
        await send(`⚠️ Input error: ${e.message}`);
        continue;
      }
    }

    // ---- command /cmd ----
    const [cmdRaw, ...args] = text.split(/\s+/);
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

module.exports = { send, editMessage, answerCallback, pollCommands };
