// Отправка снимка csfloat-bid-scan в Telegram — тем же ботом, что уже
// используется в csfloat-bot (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID из .env).
// Файл шлём как документ (sendDocument), а не текстом — лимит текстового
// сообщения Telegram (4096 символов) список из сотни предметов не переживёт.
const TELEGRAM_API = "https://api.telegram.org";

async function sendScanToTelegram(snapshot, { botToken, chatId }) {
  if (!botToken || !chatId) return { sent: false, reason: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы в .env" };

  const caption = `CSFloat bid watchlist: ${snapshot.count} новых позиций` +
    (snapshot.skippedAlreadyTracked ? `, уже в списке: ${snapshot.skippedAlreadyTracked}` : "") +
    (snapshot.skippedPatternWear ? `, не то качество раскраски: ${snapshot.skippedPatternWear}` : "") +
    (snapshot.skippedNoWearTier ? `, без стандартного качества: ${snapshot.skippedNoWearTier}` : "") +
    `\n${new Date(snapshot.generatedAt).toLocaleString("ru-RU")}`;

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption.slice(0, 1024));
  form.append(
    "document",
    new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
    "csfloat-bid-watchlist.json"
  );

  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`telegram sendDocument ${res.status}: ${text}`);
  }

  return { sent: true };
}

module.exports = { sendScanToTelegram };
