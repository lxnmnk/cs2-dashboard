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

// Наши собственные аккаунты: продажи с них — это не клиенты, а наши же
// сделки. Им мы ничего не должны, и в "Продажах клиентов" их не показываем.
const OWN_STEAM_IDS = new Set([
  "76561199060089261", // lxnmnk
  "76561198158130074", // TARHUN
]);
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
// kind — звичайний викуп ("sell") чи сторона клієнта в обміні ("trade").
// Від нього залежить, у який баланс ляжуть гроші (див. computeBalance) і що
// означає "виплачено": у викупі — переказали гроші, в обміні — віддали скіни.
function record({ id, steamId, customerName, items, totalPrice, offerId, expiresAt, botSteamId, botProfile, kind }) {
  const sales = loadAll();
  sales.push({
    id,
    steamId,
    customerName,
    kind: kind === "trade" ? "trade" : "sell",
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
  // У Skinbux успішний продаж іде created -> pending -> hold -> completed,
  // де "hold" означає, що обмін прийнято і гроші заморожено на 7 днів, а
  // "completed" — що вони вже розморожені. Тому дату холду фіксуємо саме на
  // переході в "hold": від неї рахується, коли кошти стануть доступні.
  if (status === "hold" && !sale.heldAt) {
    sale.heldAt = new Date().toISOString();
  }
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
  return loadAll()
    .filter((s) => s.steamId === steamId)
    .map((s) => ({ ...s, unlockAt: unlockAtOf(s) }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Коли гроші за угоду вийдуть із холду. Skinbux тримає їх 7 днів від моменту
// прийняття обміну — його ми фіксуємо як heldAt. Якщо угода вже "completed",
// холд позаду, і дата ні до чого.
function unlockAtOf(sale) {
  if (sale.status !== "hold" || !sale.heldAt) return null;
  return new Date(new Date(sale.heldAt).getTime() + HOLD_DAYS * 86400000).toISOString();
}

/**
 * Баланс клієнта: скільки ми йому винні за продажі, які реально відбулися.
 * Спираємось на статуси самого Skinbux — "hold" це прийнятий обмін із
 * замороженими на 7 днів грошима, "completed" — гроші вже розморожені.
 * Скасовані угоди й ті, за які ми вже розрахувались (paidAt), не рахуються.
 *
 * Три баланси, і холд тут тільки один:
 *   available — гроші за викуп, які вже можна вивести;
 *   hold      — гроші за викуп, які Skinbux тримає 7 днів;
 *   trade     — сторона клієнта в обміні. Ці гроші НЕ в холді, хоч у Skinbux
 *               вони так само заморожені: обмін ми віддаємо день у день зі
 *               своїх скінів, тобто 7 днів чекаємо ми, а не клієнт. Тому
 *               trade-баланс можна витратити на наші скіни одразу — але лише
 *               на них, а не вивести грошима.
 */
function computeBalance(steamId) {
  let available = 0;
  let hold = 0;
  let trade = 0;

  for (const sale of loadAll()) {
    if (sale.steamId !== steamId || sale.paidAt) continue;
    const accepted = sale.status === "hold" || sale.status === "completed";
    if (!accepted) continue;
    if (sale.kind === "trade") trade += sale.totalPrice;
    else if (sale.status === "hold") hold += sale.totalPrice;
    else available += sale.totalPrice;
  }

  return { available: round2(available), hold: round2(hold), trade: round2(trade) };
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

// Скасувати позначку "виплачено" — на випадок, якщо натиснув не на тій угоді.
function unmarkPaid(id) {
  const sales = loadAll();
  const sale = sales.find((s) => String(s.id) === String(id));
  if (!sale) return null;
  delete sale.paidAt;
  sale.updatedAt = new Date().toISOString();
  saveAll(sales);
  return sale;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { OWN_STEAM_IDS, record, updateStatus, loadAll, listByUser, computeBalance, markPaid, unmarkPaid, unlockAtOf, HOLD_DAYS };
