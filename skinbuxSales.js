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
const OWNER_STEAM_ID = "76561199060089261"; // lxnmnk
// Друзья, которые продают через наш аккаунт Skinbux: деньги за их продажи
// приходят к нам, но принадлежат им — это долг, а не заработок.
// У TARHUN два аккаунта: второй (ник picture) продаёт через сайт так же.
const PARTNER_STEAM_IDS = { "76561198158130074": "TARHUN", "76561199557269637": "TARHUN" };
const OWN_STEAM_IDS = new Set([OWNER_STEAM_ID, ...Object.keys(PARTNER_STEAM_IDS)]);
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
// payoutMethod — як людина хоче отримати гроші (картка / крипта), а
// payoutDetails — куди саме: банк, номер картки й ім'я або мережа й адреса
// гаманця (див. payoutDetails.js). Ми не переказуємо автоматично, виплату
// робить власник руками, і без цих полів доводилось щоразу випитувати
// реквізити в Telegram уже після того, як гроші вийшли з холду.
// promoCode — хто привів цього клієнта (promoCodes.js). Потрібен, щоб
// порахувати, скільки партнеру належить за приведених людей.
// referrerSteamId/referralPercent — клієнт, який запросив цього (referrals.js),
// і його відсоток на момент продажу: з них рахується реферальне нарахування.
// referralTopUp — реферальні гроші самого продавця, які він додав до цієї
// виплати: ми винні йому totalPrice + referralTopUp.
// reviewBonusPercent — разовий бонус за відгук, який увійшов у ціну цього продажу.
function record({ id, steamId, customerName, items, totalPrice, offerId, expiresAt, botSteamId, botProfile, kind, payoutMethod, payoutDetails, promoCode, referrerSteamId, referralPercent, referralTopUp, reviewBonusPercent, uahRate }) {
  const sales = loadAll();
  const sale = {
    id,
    steamId,
    customerName,
    kind: kind === "trade" ? "trade" : "sell",
    payoutMethod: payoutMethod || null,
    payoutDetails: payoutDetails || null,
    promoCode: promoCode || null,
    referrerSteamId: referrerSteamId ? String(referrerSteamId) : null,
    referralPercent: referrerSteamId ? Number(referralPercent) || 0 : null,
    referralTopUp: Number(referralTopUp) > 0 ? round2(referralTopUp) : 0,
    reviewBonusPercent: Number(reviewBonusPercent) || 0,
    // Курс гривні в момент продажу (виплата на картку): за ним і платимо.
    uahRate: Number(uahRate) > 0 ? Number(uahRate) : null,
    items,
    totalPrice,
    offerId,
    expiresAt,
    botSteamId: botSteamId || null,
    botProfile: botProfile || null,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  sales.push(sale);
  saveAll(sales);
  return sale;
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
    else if (sale.status === "hold") hold += amountOwed(sale);
    else available += amountOwed(sale);
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

/**
 * Угоди, за якими вже можна платити, але ще не платили: гроші вийшли з
 * холду Skinbux, позначки "виплачено" немає. Обмін сюди не рахуємо — за
 * нього віддають скіни, а не гроші.
 */
function payableNow() {
  return loadAll().filter((s) => s.status === "completed" && !s.paidAt && (s.kind || "sell") !== "trade");
}

/**
 * Позначка "власнику вже сказали, що можна платити". Без неї нагадування
 * про ту саму угоду приходило б щоразу, коли ми перечитуємо статуси.
 */
function markNotifiedPayable(id) {
  const sales = loadAll();
  const sale = sales.find((s) => String(s.id) === String(id));
  if (!sale) return null;
  sale.notifiedPayableAt = new Date().toISOString();
  saveAll(sales);
  return sale;
}

/**
 * Службова позначка на угоді ("вже сповістили про X") — щоб сповіщення
 * не приходило двічі. Ставиться лише раз: повторний виклик її не зсуває.
 */
function setFlag(id, field) {
  const sales = loadAll();
  const sale = sales.find((s) => String(s.id) === String(id));
  if (!sale) return null;
  if (!sale[field]) {
    sale[field] = new Date().toISOString();
    saveAll(sales);
  }
  return sale;
}

/** Останні реквізити клієнта — щоб не вписувати картку при кожному продажу. */
function lastPayout(steamId) {
  const sale = loadAll()
    .filter((s) => s.steamId === steamId && s.payoutDetails)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return sale ? { method: sale.payoutMethod, details: sale.payoutDetails } : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Скільки ми винні клієнту за продаж: ціна його скінів плюс реферальні гроші, які він до неї додав. */
function amountOwed(sale) {
  return round2((Number(sale.totalPrice) || 0) + (Number(sale.referralTopUp) || 0));
}

module.exports = { OWN_STEAM_IDS, OWNER_STEAM_ID, PARTNER_STEAM_IDS, record, updateStatus, loadAll, listByUser, computeBalance, markPaid, unmarkPaid, unlockAtOf, payableNow, markNotifiedPayable, setFlag, lastPayout, amountOwed, HOLD_DAYS };
