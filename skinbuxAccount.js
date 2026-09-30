// Баланс партнёрского аккаунта Skinbux — строка банка (capitalBank.js).
//
// Эндпоинта нет в их документации (там только /buy, /sell, /requestSell,
// /status/:id и инвентарь), но он работает и отдаёт ровно то, что нужно:
//   { "balance": 105375, "pendingBalance": 632119 }
// Оба числа в центах: balance — можно выводить сейчас, pendingBalance — ещё
// в холде (Skinbux держит деньги 7 дней после обмена, см. skinbuxSales.js).
//
// В банк идут оба: деньги в холде никуда не денутся, просто придут позже —
// ровно как предметы в трейд-бане. Но показываем их отдельной строкой, чтобы
// было видно, какая часть банка сейчас недоступна.
const BASE = "https://api.skinbux.com/v1";

async function fetchBalance(apiKey) {
  if (!apiKey) throw new Error("SKINBUX_API_KEY не задан");

  const res = await fetch(`${BASE}/account/balance`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Skinbux ответил ${res.status}: ${text.slice(0, 120)}`);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Skinbux вернул не JSON");
  }
  const data = payload?.data;
  if (!payload?.success || !data) throw new Error("Skinbux не отдал баланс");

  const available = Math.round(Number(data.balance) || 0) / 100;
  const pending = Math.round(Number(data.pendingBalance) || 0) / 100;
  return { available, pending, total: Math.round((available + pending) * 100) / 100 };
}

module.exports = { fetchBalance };

// ---- Из чего состоит холд ----
//
// Вопрос "сколько из 6300 в холде мои, сколько друга, а сколько клиентских"
// их API напрямую не отвечает: /account/transactions отдаёт сумму и предметы,
// но НЕ отдаёт steamId продавца. Зато id транзакции там тот же, что мы
// сохраняем в своём журнале продаж (skinbuxSales.js), а в журнале steamId
// есть — по нему и раскладываем.
//
// Второе наблюдение: транзакций со статусом "hold" у них не бывает вовсе.
// Обмен сразу становится "completed", а деньги 7 дней лежат в pendingBalance.
// Проверено на живом аккаунте: сумма completed за последние 7 дней совпала с
// pendingBalance до цента.
const HOLD_DAYS = 7;

/** Все транзакции аккаунта, от свежих к старым. */
async function fetchTransactions(apiKey, { maxPages = 20, pageSize = 100 } = {}) {
  if (!apiKey) throw new Error("SKINBUX_API_KEY не задан");
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${BASE}/account/transactions?page=${page}&pageSize=${pageSize}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Skinbux ответил ${res.status}`);
    const payload = await res.json();
    const list = payload?.data?.transactions || [];
    all.push(...list);
    if (list.length < pageSize) break;
  }
  return all;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Раскладывает деньги в холде по тому, чьи они.
 *
 * sales — записи нашего журнала (skinbuxSales.loadAll()), ownerSteamId — мой
 * аккаунт, partners — { steamId: имя } друзей, продающих через наш Skinbux.
 *
 *   mine     — мои собственные продажи, деньги мои целиком;
 *   partners — продажи друга: вернуть ему всю сумму;
 *   clients  — продажи через gaben.market: клиенту причитается то, что мы ему
 *              обещали (totalPrice из журнала), остальное — наш заработок;
 *   unknown  — транзакции, которых нет в журнале (продано мимо сайта).
 *              Не гадаем, а показываем отдельно.
 */

// Названия площадок, означающие "куплено у клиента": вписываются руками в
// поле Bought On, когда сделка сделана напрямую, а не через сайт.
const CLIENT_BUY_SOURCES = new Set(["gabenmarket", "gaben", "client", "клиент"]);
// С этого дня "gaben.market" в поле Bought On означает "куплено у клиента".
// Раньше это поле заполнялось по другому поводу, поэтому старые сделки под
// правило не попадают — иначе в клиентские уехали бы давние свои покупки.
const CLIENT_SOURCE_SINCE = Date.parse("2026-09-30T00:00:00Z");

function boughtFromClient(trade) {
  if (!CLIENT_BUY_SOURCES.has(normalizeSource(trade.buySource))) return false;
  const at = Date.parse(trade.buyDate);
  return Number.isFinite(at) && at >= CLIENT_SOURCE_SINCE;
}

function normalizeSource(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, "");
}

/** Проданные через Skinbux сделки трекера: название -> список, по одной штуке. */
function buildTrackerIndex(trackerSales) {
  const index = new Map();
  for (const t of trackerSales) {
    if (t.status !== "sold" || normalizeSource(t.sellSource) !== "skinbux") continue;
    const list = index.get(t.marketHashName) || [];
    list.push(t);
    index.set(t.marketHashName, list);
  }
  return index;
}

/**
 * Ищет сделки трекера, из которых состоит транзакция. Совпадение по названию
 * предмета и цене продажи: у Skinbux комиссии нет, поэтому цена в трекере
 * равна цене предмета в транзакции. Транзакция из двух предметов найдёт обе
 * свои сделки.
 *
 * fromClient — хотя бы одна из сделок куплена у клиента (Bought On:
 * gaben.market), тогда payout это сумма, которую мы клиенту заплатили.
 */
function matchTracker(tx, index) {
  const items = tx.tradeItems || [];
  if (!items.length) return null;

  const found = [];
  for (const item of items) {
    const list = index.get(item.name);
    if (!list?.length) continue;
    const price = round2((Number(item.price) || 0) / 100);
    const at = list.findIndex((t) => Math.abs(round2(t.sellPrice) - price) < 0.02);
    if (at < 0) continue;
    found.push(list.splice(at, 1)[0]);
  }
  if (!found.length) return null;

  const fromClient = found.some(boughtFromClient);
  const payout = round2(found.reduce((sum, t) => sum + (Number(t.buyPrice) || 0), 0));
  // Если из нескольких предметов транзакции нашлась только часть, относить
  // к клиенту всю сумму нельзя: выручка считалась бы по всем предметам, а
  // выплата по найденным, и маржа выходила бы завышенной.
  const matchedAmount = round2(found.reduce((sum, t) => sum + (Number(t.sellPrice) || 0), 0));
  return { trades: found, fromClient, payout, matchedAmount };
}

function splitHold(transactions, { sales, trackerSales = [], ownerSteamId, partners = {}, holdDays = HOLD_DAYS }) {
  const cutoff = Date.now() - holdDays * 86400000;
  const byId = new Map(sales.map((s) => [String(s.id), s]));
  const trackerIndex = buildTrackerIndex(trackerSales);

  const result = {
    total: 0,
    mine: 0,
    partners: {},
    clients: { gross: 0, payout: 0, margin: 0 },
    // Часть "моего", которую подтвердить нечем: продажи мимо сайта,
    // не заведённые в трекер.
    unconfirmed: { sum: 0, count: 0 },
    items: [],
    nextUnlockAt: null,
  };

  for (const tx of transactions) {
    if (tx.status !== "completed") continue;
    const doneAt = new Date(tx.updatedAt || tx.createdAt).getTime();
    if (!(doneAt >= cutoff)) continue;

    const amount = round2((Number(tx.price) || 0) / 100);
    result.total = round2(result.total + amount);

    const unlockAt = new Date(doneAt + holdDays * 86400000).toISOString();
    if (!result.nextUnlockAt || unlockAt < result.nextUnlockAt) result.nextUnlockAt = unlockAt;

    const sale = byId.get(String(tx.id));
    const steamId = sale ? String(sale.steamId) : null;
    // Продажи мимо сайта (свои скины и ручные продажи за клиента) в журнале
    // не лежат, зато лежат в трекере сделок: там записано, за сколько предмет
    // куплен и где продан. Сопоставляем по названию и цене предмета — Skinbux
    // отдаёт их в tradeItems, комиссии у него нет, поэтому цены совпадают.
    const matched = steamId ? null : matchTracker(tx, trackerIndex);
    let owner;

    if (matched && matched.fromClient) {
      owner = "client";
      const known = round2(Math.min(matched.matchedAmount, amount));
      result.clients.gross = round2(result.clients.gross + known);
      result.clients.payout = round2(result.clients.payout + matched.payout);
      result.clients.margin = round2(result.clients.margin + (known - matched.payout));
      // Не опознанный остаток транзакции остаётся в "моё" (см. ниже).
      result.identifiedRest = round2((result.identifiedRest || 0) + (amount - known));
    } else if (!steamId) {
      // Продажа мимо сайта, которой нет в трекере: деньги наши, просто
      // подтвердить их нечем — считаем в "моё" и отмечаем как неподтверждённые.
      owner = "mine";
      result.unconfirmed.sum = round2(result.unconfirmed.sum + amount);
      result.unconfirmed.count++;
    } else if (steamId === ownerSteamId) {
      owner = "mine";
    } else if (partners[steamId]) {
      owner = partners[steamId];
      const prev = result.partners[owner] || 0;
      result.partners[owner] = round2(prev + amount);
    } else {
      owner = "client";
      // Клиенту обещана его сумма (уже с нашей скидкой), разница — наша.
      const payout = round2(Number(sale.totalPrice) || 0);
      result.clients.gross = round2(result.clients.gross + amount);
      result.clients.payout = round2(result.clients.payout + payout);
      result.clients.margin = round2(result.clients.margin + (amount - payout));
    }

    result.items.push({
      id: tx.id,
      amount,
      owner,
      steamId,
      // Откуда узнали владельца: журнал сайта, пометка руками или никак.
      via: steamId ? "journal" : matched ? "tracker" : "unknown",
      payout: matched?.fromClient ? matched.payout : sale && owner === "client" ? round2(sale.totalPrice || 0) : null,
      customerName: sale?.customerName || null,
      unlockAt,
      names: (tx.tradeItems || []).map((i) => i.name),
    });
  }

  // Моё — всё, что не придётся отдать: вычитаем долги (партнёрам целиком,
  // клиентам только их выплату), а маржа с клиентских продаж остаётся у нас.
  // Три строки в сумме дают весь холд: моё + партнёры + выплата клиентам.
  const partnersTotal = Object.values(result.partners).reduce((sum, v) => sum + v, 0);
  result.mine = round2(result.total - partnersTotal - result.clients.payout);
  delete result.identifiedRest;
  return result;
}

module.exports.fetchTransactions = fetchTransactions;
module.exports.splitHold = splitHold;
module.exports.CLIENT_BUY_SOURCES = CLIENT_BUY_SOURCES;
module.exports.boughtFromClient = boughtFromClient;
module.exports.CLIENT_SOURCE_SINCE = CLIENT_SOURCE_SINCE;
module.exports.normalizeSource = normalizeSource;
module.exports.HOLD_DAYS = HOLD_DAYS;
