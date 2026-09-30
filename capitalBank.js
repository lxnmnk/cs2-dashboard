// Банк бизнеса на сегодня: сколько у нас всего денег, если посчитать всё.
// Раньше это собиралось руками в Excel раз в две недели, поэтому и считалось
// по цене, которую видно на витрине, а не по той, которую реально заплатят.
//
// Правила оценки (выбраны владельцем):
//   - предмет можно продать сейчас -> лучший bid минус комиссия площадки,
//     то есть сколько денег придёт на счёт, а не сколько он "стоит";
//   - предмет в трейд-бане -> цена покупки из трекера сделок: продать его
//     нельзя, значит и переоценивать по рынку нечего. Если цены покупки не
//     знаем (предмет старше трекера) — считаем по тому же bid и показываем
//     отдельно, чтобы это не терялось;
//   - долги клиентам (балансы на сайте, которые мы им должны) вычитаются:
//     это чужие деньги, и раздавать их как прибыль нельзя.
const { fetchInventory } = require("./steamInventory");
const trades = require("./trades");
const skinbuxSales = require("./skinbuxSales");
const { fetchBalance } = require("./csfloatAccount");
const skinbuxAccount = require("./skinbuxAccount");

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Сколько реально придёт за предмет, если продать его прямо сейчас:
 * лучший гарантированный вариант (bid) за вычетом комиссии площадки.
 * Считает та же функция, что и в трекере сделок, — чтобы цифры на двух
 * страницах не разошлись.
 */
function instantSellValue(marketHashName, rows, sourcesConfig) {
  const row = rows.find((r) => r.marketHashName === marketHashName);
  if (!row) return null;
  const best = trades
    .findAllSellOptions(row, sourcesConfig)
    .filter((o) => o.side === "bid")
    .shift();
  return best ? best.price : null;
}

/**
 * Цены покупки открытых позиций из трекера: имя предмета -> список цен, от
 * свежих к старым. Для предметов в трейд-бане берём отсюда.
 */
function buyPriceIndex(owner) {
  const index = new Map();
  for (const trade of trades.listRawTrades(owner)) {
    if (trade.status !== "holding") continue;
    const list = index.get(trade.marketHashName) || [];
    list.push({ assetId: trade.assetId || null, buyPrice: trade.buyPrice, buyDate: trade.buyDate });
    index.set(trade.marketHashName, list);
  }
  for (const list of index.values()) list.sort((a, b) => new Date(b.buyDate) - new Date(a.buyDate));
  return index;
}

/** Цена покупки конкретного предмета: сначала по assetId, потом по названию. */
function takeBuyPrice(index, item) {
  const list = index.get(item.marketHashName);
  if (!list?.length) return null;
  const exact = list.findIndex((t) => t.assetId && t.assetId === item.assetId);
  const [match] = list.splice(exact >= 0 ? exact : 0, 1);
  return match ? match.buyPrice : null;
}

/**
 * Оценка инвентаря Steam. Возвращает суммы и разбивку, чтобы на странице было
 * видно, какая часть банка сейчас неликвидна (в бане) и сколько предметов мы
 * не смогли оценить вообще.
 */
function valueInventory(items, { rows, sourcesConfig, owner }) {
  const index = buyPriceIndex(owner);
  const result = {
    tradable: { count: 0, value: 0 },
    // В трейд-бане: те, для кого нашли цену покупки, и те, для кого нет.
    locked: { count: 0, value: 0, atCost: 0, atMarket: 0, unknownCost: 0 },
    unpriced: { count: 0, names: [] },
    total: 0,
  };

  for (const item of items) {
    const locked = !item.tradable;
    const market = instantSellValue(item.marketHashName, rows, sourcesConfig);

    if (locked) {
      const cost = takeBuyPrice(index, item);
      const value = cost != null ? cost : market;
      if (value == null) {
        result.unpriced.count++;
        if (result.unpriced.names.length < 20) result.unpriced.names.push(item.marketHashName);
        continue;
      }
      result.locked.count++;
      result.locked.value = round2(result.locked.value + value);
      if (cost != null) result.locked.atCost = round2(result.locked.atCost + value);
      else {
        result.locked.atMarket = round2(result.locked.atMarket + value);
        result.locked.unknownCost++;
      }
      continue;
    }

    if (market == null) {
      result.unpriced.count++;
      if (result.unpriced.names.length < 20) result.unpriced.names.push(item.marketHashName);
      continue;
    }
    result.tradable.count++;
    result.tradable.value = round2(result.tradable.value + market);
  }

  result.total = round2(result.tradable.value + result.locked.value);
  return result;
}

/**
 * Сколько мы должны клиентам сайта: непогашенные балансы из их продаж.
 *
 * Баланс Skinbux — общий котёл: там и наша доля, и деньги клиентов, которые
 * мы им ещё не выплатили. Вычитаем именно долги, а не урезаем строку Skinbux,
 * чтобы было видно обе величины по отдельности.
 *
 * Продажи с наших собственных аккаунтов (см. skinbuxSales.OWN_STEAM_IDS) —
 * не долг: это наши же деньги, просто проданные через свой сайт.
 */
function clientLiabilities() {
  let payout = 0; // обычные продажи: должны деньгами
  let tradeCredit = 0; // сторона клиента в обмене: должны скинами
  for (const sale of skinbuxSales.loadAll()) {
    if (sale.paidAt) continue;
    if (skinbuxSales.OWN_STEAM_IDS.has(String(sale.steamId))) continue;
    if (sale.status !== "hold" && sale.status !== "completed") continue;
    if (sale.kind === "trade") tradeCredit = round2(tradeCredit + sale.totalPrice);
    else payout = round2(payout + sale.totalPrice);
  }
  return { payout, tradeCredit, total: round2(payout + tradeCredit) };
}

/**
 * Полный банк на сейчас. Всё, что можно узнать само, узнаётся само;
 * остальное (Youpin, Skinbux, крипта, переплата за флот) берётся из
 * вписанных руками значений (capital.json -> manual).
 */
async function collectBank({ state, rows, config, owner, refresh = false }) {
  const errors = [];

  let inventory = { tradable: { count: 0, value: 0 }, locked: { count: 0, value: 0, atCost: 0, atMarket: 0, unknownCost: 0 }, unpriced: { count: 0, names: [] }, total: 0 };
  try {
    const items = await fetchInventory(state.steamId, { force: refresh });
    inventory = valueInventory(items, { rows, sourcesConfig: config.sources, owner });
  } catch (err) {
    errors.push(`Инвентарь Steam: ${err.message}`);
  }

  // Баланс CSFloat отдаёт API, но если ключа нет или ответ не разобрали —
  // значение можно вписать руками, и оно имеет приоритет.
  let csfloat = { value: state.manual.csfloat ?? 0, source: state.manual.csfloat != null ? "manual" : "api" };
  if (state.manual.csfloat == null) {
    try {
      csfloat = { value: await fetchBalance(process.env.CSFLOAT_API_KEY), source: "api" };
    } catch (err) {
      csfloat = { value: 0, source: "error" };
      errors.push(`Баланс CSFloat: ${err.message}`);
    }
  }

  // Skinbux отдаёт и доступное, и то, что ещё в холде (7 дней после обмена).
  // В банк идёт всё: холд никуда не денется, просто придёт позже.
  let skinbux = { value: state.manual.skinbux ?? 0, source: "manual", available: null, pending: null };
  if (state.manual.skinbux == null) {
    try {
      const balance = await skinbuxAccount.fetchBalance(process.env.SKINBUX_API_KEY);
      skinbux = { value: balance.total, source: "api", available: balance.available, pending: balance.pending };
    } catch (err) {
      skinbux = { value: 0, source: "error", available: null, pending: null };
      errors.push(`Баланс Skinbux: ${err.message}`);
    }
  }

  const liabilities = clientLiabilities();
  const assets = round2(
    inventory.total + csfloat.value + skinbux.value + state.manual.youpin + state.manual.cash + state.manual.overpay
  );

  return {
    inventory,
    csfloat,
    youpin: state.manual.youpin,
    skinbux,
    cash: state.manual.cash,
    overpay: state.manual.overpay,
    liabilities,
    assets,
    total: round2(assets - liabilities.total),
    collectedAt: new Date().toISOString(),
    errors,
  };
}

module.exports = { collectBank, valueInventory, clientLiabilities, instantSellValue };
