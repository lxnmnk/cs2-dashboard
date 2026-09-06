// Журнал автоматических продаж клиентов через Skinbux (см.
// skinbuxTransactions.js) — что именно и когда ушло, чтобы вебхук
// (server.js /api/webhooks/skinbux) знал, какую запись обновлять по
// приходу статуса, и чтобы можно было свериться вручную при споре.
//
// HOLD_DAYS — сколько дней после завершения обміну (клієнт прийняв трейд)
// гроші лежать у холді, перш ніж їх можна вивести. Узгоджено з публічною
// обіцянкою на сайті "Оплата через 7 днів після обміну" (термін Steam trade
// lock) — див. public/sell-quote.html.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "skinbuxSales.json");
const HOLD_DAYS = 7;

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveAll(sales) {
  fs.writeFileSync(FILE, JSON.stringify(sales, null, 2));
}

// botSteamId/botProfile — чий саме бот надсилає обмін (Skinbux повертає це у
// відповіді на requestSell). Зберігаємо, щоб клієнт міг знайти пряме
// посилання на обмін і дані відправника пізніше, а не лише у вікні одразу
// після продажу.
function record({ id, steamId, customerName, items, totalPrice, offerId, expiresAt, botSteamId, botProfile }) {
  const sales = loadAll();
  sales.push({
    id,
    steamId,
    customerName,
    items,
    totalPrice,
    offerId,
    expiresAt,
    botSteamId: botSteamId || null,
    botProfile: botProfile || null,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveAll(sales);
}

function updateStatus(id, status, steamOfferId) {
  const sales = loadAll();
  const sale = sales.find((s) => String(s.id) === String(id));
  if (!sale) return null;
  sale.status = status;
  if (steamOfferId) sale.offerId = steamOfferId;
  // completedAt фіксуємо один раз, у момент першого переходу в "completed" —
  // саме від цієї миті рахується 7-денний холд, а не від будь-якого
  // подальшого оновлення статусу (напр. звіт про повернення заднім числом).
  if (status === "completed" && !sale.completedAt) {
    sale.completedAt = new Date().toISOString();
  }
  sale.updatedAt = new Date().toISOString();
  saveAll(sales);
  return sale;
}

/**
 * Угоди конкретного клієнта для розділу "Мої угоди" в кабінеті — з готовими
 * полями по холду, щоб фронтенду не рахувати дати самому.
 */
function listByUser(steamId) {
  const sales = loadAll().filter((s) => s.steamId === steamId);
  const now = Date.now();
  return sales
    .map((s) => {
      let unlockAt = null;
      let unlocked = false;
      if (s.completedAt) {
        unlockAt = new Date(new Date(s.completedAt).getTime() + HOLD_DAYS * 86400000).toISOString();
        unlocked = now >= new Date(unlockAt).getTime();
      }
      return { ...s, unlockAt, unlocked };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Баланс клієнта: скільки ми йому винні за завершені продажі. Рахуються
 * тільки угоди зі статусом "completed" (обмін реально відбувся) і без
 * позначки paidAt — скасовані та вже виплачені в баланс не входять.
 * available — холд минув, гроші можна забирати; hold — ще лежать.
 */
function computeBalance(steamId) {
  const now = Date.now();
  let available = 0;
  let hold = 0;

  for (const sale of loadAll()) {
    if (sale.steamId !== steamId) continue;
    if (sale.status !== "completed" || sale.paidAt || !sale.completedAt) continue;

    const unlockAt = new Date(sale.completedAt).getTime() + HOLD_DAYS * 86400000;
    if (now >= unlockAt) available += sale.totalPrice;
    else hold += sale.totalPrice;
  }

  return { available: round2(available), hold: round2(hold) };
}

// Позначка "виплачено" — після неї угода перестає враховуватись у балансі.
// Ставить власник сайту, коли реально переказав гроші клієнту.
function markPaid(id) {
  const sales = loadAll();
  const sale = sales.find((s) => String(s.id) === String(id));
  if (!sale) return null;
  sale.paidAt = new Date().toISOString();
  sale.updatedAt = sale.paidAt;
  saveAll(sales);
  return sale;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { record, updateStatus, loadAll, listByUser, computeBalance, markPaid, HOLD_DAYS };
