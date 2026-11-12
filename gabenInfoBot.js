// gaben.market_info — бот новостей сайта для владельца (TELEGRAM_INFO_BOT_TOKEN).
// Только шлёт, команд не слушает:
//   - кто-то продал скины на сайте: что, за сколько, когда;
//   - обмен принят — продажа состоялась, когда выплата;
//   - за 6 и за 2 часа до выплаты — напоминание с реквизитами;
//   - "можно платить" и заявки на вывод реферальных (шлёт server.js).
//
// Нет своего токена — шлём, как раньше, ботом выплат или основным
// (TELEGRAM_PAYOUT_BOT_TOKEN / TELEGRAM_BOT_TOKEN), чтобы ничего не потерялось.
const skinbuxSales = require("./skinbuxSales");
const payoutDetails = require("./payoutDetails");
const { sendOwnerMessage } = require("./telegramNotifier");

function infoBotCredentials() {
  return {
    botToken: process.env.TELEGRAM_INFO_BOT_TOKEN || process.env.TELEGRAM_PAYOUT_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_INFO_CHAT_ID || process.env.TELEGRAM_PAYOUT_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
  };
}

async function sendInfo(text) {
  return sendOwnerMessage(text, infoBotCredentials());
}

const KYIV = { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" };
const when = (iso) => new Date(iso).toLocaleString("ru-RU", KYIV);

function itemsLine(sale) {
  const counts = new Map();
  for (const it of sale.items || []) counts.set(it.name, (counts.get(it.name) || 0) + 1);
  return [...counts].map(([name, q]) => (q > 1 ? `${name} ×${q}` : name)).join(", ");
}

function amountLine(sale, uahRateSell) {
  const owed = skinbuxSales.amountOwed(sale);
  if (sale.payoutDetails?.method !== "card") return `$${owed.toFixed(2)}`;
  const uah = Math.round(owed * (sale.uahRate || uahRateSell || 0));
  return uah ? `$${owed.toFixed(2)} ≈ ${uah.toLocaleString("uk-UA")} ₴` : `$${owed.toFixed(2)}`;
}

const clientLine = (sale) => `${sale.customerName || "—"} (${sale.steamId})`;

/** Новая продажа на сайте — обмен ещё не принят. */
async function notifySaleCreated(sale, { uahRateSell } = {}) {
  const trade = sale.kind === "trade";
  return sendInfo(
    [
      trade ? `🔁 Обмен на сайте — сделка #${sale.id}` : `🛒 Продажа на сайте — сделка #${sale.id}`,
      `Клиент: ${clientLine(sale)}`,
      `Что: ${itemsLine(sale)}`,
      `Сумма: ${trade ? `$${Number(sale.totalPrice).toFixed(2)} (в trade-баланс)` : amountLine(sale, uahRateSell)}`,
      `Когда: ${when(sale.createdAt || Date.now())}`,
      "Ждёт, пока клиент примет обмен в Steam.",
    ].join("\n")
  );
}

/** Обмен принят — продажа состоялась, деньги в холде Skinbux. */
async function notifySaleAccepted(sale, { uahRateSell } = {}) {
  const unlockAt = skinbuxSales.unlockAtOf(sale);
  const trade = sale.kind === "trade";
  return sendInfo(
    [
      `✅ Обмен принят — сделка #${sale.id}`,
      `Клиент: ${clientLine(sale)}`,
      `Что: ${itemsLine(sale)}`,
      `Сумма: ${trade ? `$${Number(sale.totalPrice).toFixed(2)} (обмен, деньгами не платим)` : amountLine(sale, uahRateSell)}`,
      `Принят: ${when(sale.heldAt || Date.now())}`,
      !trade && unlockAt ? `Выплата: ${when(unlockAt)} (напомню за 6 и 2 часа)` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );
}

const REMINDERS = [
  { hours: 2, field: "payoutReminder2hAt" },
  { hours: 6, field: "payoutReminder6hAt" },
];

/**
 * Напоминания о выплатах: за 6 и за 2 часа до выхода денег из холда.
 * Если угоду увидели поздно (до выплаты уже меньше 2 ч) — одно напоминание,
 * без "за 6 часов" задним числом.
 */
async function remindUpcomingPayouts({ uahRateSell } = {}) {
  const now = Date.now();
  for (const sale of skinbuxSales.loadAll()) {
    if (sale.paidAt || (sale.kind || "sell") === "trade" || sale.status !== "hold") continue;
    // Наші акаунти й TARHUN — не клієнти, нагадувати про них не треба.
    if (skinbuxSales.OWN_STEAM_IDS.has(String(sale.steamId))) continue;
    const unlockAt = skinbuxSales.unlockAtOf(sale);
    if (!unlockAt) continue;
    const left = Date.parse(unlockAt) - now;
    if (left <= 0) continue; // дальше придёт "можно платить"
    const due = REMINDERS.find((r) => left <= r.hours * 3600000 && !sale[r.field]);
    if (!due) continue;

    const hoursLeft = Math.max(1, Math.round(left / 3600000));
    const text = [
      `⏰ Выплата через ~${hoursLeft} ч — сделка #${sale.id}`,
      `Клиент: ${clientLine(sale)}`,
      `Сумма: ${amountLine(sale, uahRateSell)}`,
      sale.referralTopUp ? `  (в т.ч. реферальные $${Number(sale.referralTopUp).toFixed(2)})` : null,
      `Куда: ${payoutDetails.describe(sale.payoutDetails) || "реквизиты не указаны — спроси в Telegram"}`,
      `Когда: ${when(unlockAt)}`,
      `Что: ${itemsLine(sale)}`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const res = await sendInfo(text);
      if (!res.sent) {
        console.warn(`[payout] Напоминание по угоде ${sale.id} не надіслано: ${res.reason}`);
        continue;
      }
      // "За 2 часа" закрывает и "за 6": второе после первого не нужно.
      for (const r of REMINDERS) if (r.hours >= due.hours) skinbuxSales.setFlag(sale.id, r.field);
    } catch (err) {
      console.error(`[payout] Напоминание по угоде ${sale.id}:`, err.message);
    }
  }
}

module.exports = { infoBotCredentials, sendInfo, notifySaleCreated, notifySaleAccepted, remindUpcomingPayouts };
