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

function record({ id, steamId, customerName, items, totalPrice, offerId, expiresAt }) {
  const sales = loadAll();
  sales.push({
    id,
    steamId,
    customerName,
    items,
    totalPrice,
    offerId,
    expiresAt,
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

module.exports = { record, updateStatus, loadAll, listByUser, HOLD_DAYS };
