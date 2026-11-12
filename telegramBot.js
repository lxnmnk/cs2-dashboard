// Общие кирпичики для Telegram-ботов сайта. Ботов несколько, у каждого свой
// токен и своё дело:
//   Arbitrage_cs2     (TELEGRAM_ARB_BOT_TOKEN)     — выгодные лоты для ручной покупки;
//   csf_bargains      (TELEGRAM_BARGAIN_BOT_TOKEN) — автобарги CSFloat;
//   gaben.market_info (TELEGRAM_INFO_BOT_TOKEN)    — продажи на сайте и выплаты;
//   sell-бот          (TELEGRAM_SELL_BOT_TOKEN)    — где и почём продать мой инвентарь.
// Токены разные намеренно: long polling одним токеном из двух мест Telegram
// не пускает (409 Conflict), а в одном чате всё смешивалось в кашу.
const TELEGRAM_API = "https://api.telegram.org";

async function tgCall(token, method, body) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === "getUpdates" ? 45000 : 15000),
  });
  return res.json();
}

/**
 * Сообщение в HTML-разметке. Ошибку Telegram не глотаем: тот, кто зовёт,
 * сам решает — залогировать или отдать дальше.
 */
async function sendMessage(token, chatId, text, extra = {}) {
  const res = await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
  if (!res?.ok) throw new Error(`telegram sendMessage: ${res?.description || "нет ответа"}`);
  return res;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function escapeAttr(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Чат владельца — в личке chat_id = id пользователя, он одинаков для всех ботов. */
function ownerChatId(specific) {
  return String(specific || process.env.TELEGRAM_CHAT_ID || "");
}

/**
 * Фоновый long polling. onMessage(msg) / onCallback(cq) — обработчики;
 * ошибка в одном апдейте не роняет цикл.
 */
async function startPolling(token, tag, { onMessage, onCallback }) {
  let offset = 0;
  let lastError = null;
  try {
    const seed = await tgCall(token, "getUpdates", { offset: -1, timeout: 0 });
    if (seed.ok && seed.result.length) offset = seed.result[seed.result.length - 1].update_id + 1;
  } catch {
    // не критично — начнём с текущего момента после первого успешного вызова
  }

  for (;;) {
    try {
      const res = await tgCall(token, "getUpdates", { offset, timeout: 30 });
      if (!res.ok) {
        // Одну и ту же ошибку пишем в лог раз, а не каждые 3 секунды.
        const why = res.error_code === 409 ? "409: этим токеном уже слушает другой процесс" : `${res.error_code}: ${res.description} — проверь токен в .env`;
        if (why !== lastError) console.error(`[${tag}] getUpdates ${why}`);
        lastError = why;
        await sleep(3000);
        continue;
      }
      lastError = null;
      for (const update of res.result) {
        offset = update.update_id + 1;
        if (update.message && onMessage) {
          await onMessage(update.message).catch((e) => console.error(`[${tag}] message:`, e.message));
        } else if (update.callback_query && onCallback) {
          await tgCall(token, "answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => {});
          await onCallback(update.callback_query).catch((e) => console.error(`[${tag}] callback:`, e.message));
        }
      }
    } catch (err) {
      console.error(`[${tag}] polling error: ${err.message}`);
      await sleep(3000);
    }
  }
}

/** "/cmd@bot a b" -> { cmd: "/cmd", args: ["a", "b"] } или null, если это не команда. */
function parseCommand(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("/")) return null;
  const [cmdRaw, ...args] = t.split(/\s+/);
  return { cmd: cmdRaw.toLowerCase().split("@")[0], args };
}

module.exports = { tgCall, sendMessage, escapeHtml, escapeAttr, sleep, ownerChatId, startPolling, parseCommand };
