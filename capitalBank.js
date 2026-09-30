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
 * Оценка инвентаря по открытым позициям трекера (/mytrades) — он и есть наш
 * учёт: там цена покупки, дата разблокировки и текущий bid по каждому
 * предмету, и он пополняется автоматически импортом покупок с CSFloat.
 *
 * Инвентарь Steam для этого не годится: его публичная версия НЕ показывает
 * трейд-бан (owner_descriptions с "Tradable After" отдаются только самому
 * владельцу при входе), поэтому только что купленные скины выглядели там
 * свободными, а в "бане" оказывались медали и брелоки, которые не торгуются
 * вообще и к бизнесу отношения не имеют.
 */
function valueTracker({ owner, rows, config }) {
  const result = {
    tradable: { count: 0, value: 0 },
    locked: { count: 0, value: 0 },
    // Предмет без цены в снапшоте: в банк идёт по цене покупки, но мы это
    // показываем — значит, оценка у него не рыночная.
    noMarketPrice: { count: 0, value: 0, names: [] },
    total: 0,
  };

  for (const trade of trades.listTrades({ owner, rows, config })) {
    if (trade.status !== "holding") continue;

    if (trade.isLocked) {
      // В трейд-бане — по цене покупки: продать нельзя, переоценивать нечего.
      result.locked.count++;
      result.locked.value = round2(result.locked.value + trade.buyPrice);
      continue;
    }

    const bid = (trade.sellOptions || []).filter((o) => o.side === "bid")[0];
    if (!bid) {
      result.noMarketPrice.count++;
      result.noMarketPrice.value = round2(result.noMarketPrice.value + trade.buyPrice);
      if (result.noMarketPrice.names.length < 20) result.noMarketPrice.names.push(trade.marketHashName);
      continue;
    }
    result.tradable.count++;
    result.tradable.value = round2(result.tradable.value + bid.price);
  }

  result.total = round2(result.tradable.value + result.locked.value + result.noMarketPrice.value);
  return result;
}

/**
 * Сверка с реальным инвентарём Steam: предметы, которые лежат в аккаунте, но
 * в трекере их нет. В банк они не идут (трекер — источник истины), но молча
 * терять их нельзя, поэтому считаем и показываем отдельно.
 */
function untrackedSteamItems(items, { owner, rows, sourcesConfig }) {
  const holdings = new Map();
  for (const trade of trades.listRawTrades(owner)) {
    if (trade.status !== "holding") continue;
    holdings.set(trade.marketHashName, (holdings.get(trade.marketHashName) || 0) + 1);
  }

  const result = { count: 0, value: 0, names: [] };
  for (const item of items) {
    const left = holdings.get(item.marketHashName) || 0;
    if (left > 0) {
      holdings.set(item.marketHashName, left - 1);
      continue;
    }
    // Медали, монеты, брелоки и прочее, что не торгуется и цены не имеет, в
    // сверку не тащим — это не товар.
    const market = instantSellValue(item.marketHashName, rows, sourcesConfig);
    if (market == null) continue;
    result.count++;
    result.value = round2(result.value + market);
    if (result.names.length < 20) result.names.push(item.marketHashName);
  }
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

  // Инвентарь считаем по трекеру сделок, а Steam используем только для
  // сверки: не потерялось ли что-то, чего в трекере нет.
  const inventory = valueTracker({ owner, rows, config });
  let untracked = { count: 0, value: 0, names: [] };
  try {
    const items = await fetchInventory(state.steamId, { force: refresh });
    untracked = untrackedSteamItems(items, { owner, rows, sourcesConfig: config.sources });
  } catch (err) {
    errors.push(`Сверка с инвентарём Steam не вышла: ${err.message}`);
  }

  // Баланс CSFloat отдаёт API, но если ключа нет или ответ не разобрали —
  // значение можно вписать руками, и оно имеет приоритет.
  let csfloat = { value: state.manual.csfloat ?? 0, source: state.manual.csfloat != null ? "manual" : "api" };
  if (state.manual.csfloat == null) {
    try {
      const live = await fetchBalance(process.env.CSFLOAT_API_KEY);
      csfloat = { value: live.total, source: "api", available: live.available, pending: live.pending };
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
    untracked,
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

module.exports = { collectBank, valueTracker, untrackedSteamItems, clientLiabilities, instantSellValue };
