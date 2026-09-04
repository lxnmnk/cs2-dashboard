// Отправка снимка csfloat-bid-scan в Telegram — тем же ботом, что уже
// используется в csfloat-bot (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID из .env).
// Файл шлём как документ (sendDocument), а не текстом — лимит текстового
// сообщения Telegram (4096 символов) список из сотни предметов не переживёт.
//
// Отправляем ТОЛЬКО массив importItems, а не весь снимок: импорт в csfloat-bot
// разбирает файл как []importItemEntry, и на объекте с полями generatedAt/
// filters/details падает с "cannot unmarshal object into Go value of type
// []cs2shitems.importItemEntry". Полный снимок с ценами и профитом остаётся в
// csfloat-bid-watchlist.json и в GET /api/csfloat-bid-scan.
const TELEGRAM_API = "https://api.telegram.org";

async function sendScanToTelegram(snapshot, { botToken, chatId }) {
  if (!botToken || !chatId) return { sent: false, reason: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы в .env" };

  // Подпись без "/" в начале: caption, начинающийся с /syncitems, включил бы в
  // боте полную синхронизацию (деактивацию всего, чего нет в файле) — нам нужен
  // обычный additive-импорт, поэтому команду в подпись не ставим.
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
    new Blob([JSON.stringify(snapshot.importItems, null, 2)], { type: "application/json" }),
    "csfloat-bid-import.json"
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
