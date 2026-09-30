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
function splitHold(transactions, { sales, ownerSteamId, partners = {}, holdDays = HOLD_DAYS }) {
  const cutoff = Date.now() - holdDays * 86400000;
  const byId = new Map(sales.map((s) => [String(s.id), s]));

  const result = {
    total: 0,
    mine: 0,
    partners: {},
    clients: { gross: 0, payout: 0, margin: 0 },
    unknown: { sum: 0, count: 0 },
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
    let owner;

    if (!steamId) {
      owner = "unknown";
      result.unknown.sum = round2(result.unknown.sum + amount);
      result.unknown.count++;
    } else if (steamId === ownerSteamId) {
      owner = "mine";
      result.mine = round2(result.mine + amount);
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
      customerName: sale?.customerName || null,
      unlockAt,
      names: (tx.tradeItems || []).map((i) => i.name),
    });
  }

  return result;
}

module.exports.fetchTransactions = fetchTransactions;
module.exports.splitHold = splitHold;
module.exports.HOLD_DAYS = HOLD_DAYS;
