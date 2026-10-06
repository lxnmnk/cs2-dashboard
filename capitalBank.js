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
  const result = { count: 0, locked: 0, total: 0, marketValue: 0 };

  for (const trade of trades.listTrades({ owner, rows, config })) {
    if (trade.status !== "holding") continue;
    result.count++;
    if (trade.isLocked) result.locked++;
    result.total = round2(result.total + trade.buyPrice);

    // Сколько это стоит по рынку — только справочно, рядом со строкой. В банк
    // идёт цена покупки: так же считает карточка "Skins in Steam" в My Trades,
    // и два экрана не должны показывать разные числа за одно и то же.
    const bid = (trade.sellOptions || []).filter((o) => o.side === "bid")[0];
    result.marketValue = round2(result.marketValue + (bid ? bid.price : trade.buyPrice));
  }

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
 * Сколько мы должны: клиентам сайта — непогашенные балансы из их продаж,
 * друзьям — всё, что пришло за их предметы и ещё не возвращено.
 *
 * Баланс Skinbux — общий котёл: там и наша доля, и деньги клиентов, которые
 * мы им ещё не выплатили. Вычитаем именно долги, а не урезаем строку Skinbux,
 * чтобы было видно обе величины по отдельности.
 *
 * Продажи с моего собственного аккаунта — не долг: это мои же деньги, просто
 * проданные через свой сайт. А вот продажи друга (PARTNER_STEAM_IDS) — долг:
 * деньги пришли к нам, но принадлежат ему. Раньше они проходили как "наши" и
 * ушли бы инвесторам в прибыль.
 */
function clientLiabilities(transactions = []) {
  // Транзакция Skinbux по id записи журнала: нужна для долга партнёру — ему
  // возвращается всё, что пришло за его предметы, а не наша запись totalPrice
  // (в ней сидела бы скидка, которой с друга мы не берём). Так же считает
  // раскладка холда в трекере, и те числа уже сверены вручную.
  const txById = new Map((transactions || []).map((t) => [String(t.id), t]));

  let payout = 0; // обычные продажи: должны деньгами
  let tradeCredit = 0; // сторона клиента в обмене: должны скинами
  const partners = {}; // друзья, продающие через наш аккаунт: имя -> сколько должны
  let partnersTotal = 0;

  for (const sale of skinbuxSales.loadAll()) {
    if (sale.paidAt) continue;
    if (String(sale.steamId) === skinbuxSales.OWNER_STEAM_ID) continue;
    if (sale.status !== "hold" && sale.status !== "completed") continue;

    const partner = skinbuxSales.PARTNER_STEAM_IDS[String(sale.steamId)];
    if (partner) {
      const tx = txById.get(String(sale.id));
      const amount = tx ? round2((Number(tx.price) || 0) / 100) : round2(sale.totalPrice);
      partners[partner] = round2((partners[partner] || 0) + amount);
      partnersTotal = round2(partnersTotal + amount);
      continue;
    }

    if (sale.kind === "trade") tradeCredit = round2(tradeCredit + sale.totalPrice);
    else payout = round2(payout + sale.totalPrice);
  }

  return { payout, tradeCredit, partners, partnersTotal, total: round2(payout + tradeCredit + partnersTotal) };
}

/**
 * Полный банк на сейчас — ровно из тех же чисел, что видно во вкладке
 * My Trades, строка в строку.
 *
 * Балансы площадок берём целиком: доступное плюс холд плюс заморозка. Деньги
 * в холде никуда не денутся, просто придут позже, а бизнес ими владеет уже
 * сейчас. Отдельных ручных полей для Youpin, крипты и прочего больше нет:
 * где число правится карандашом в My Trades, там оно и живёт, иначе одно и то
 * же приходилось бы держать в двух местах и они разъезжались.
 *
 * Скины — одной строкой по цене покупки, как карточка "Skins in Steam".
 * Долги (клиентам и друзьям) вычитаются: это чужие деньги.
 */

// Карточки My Trades, которые в банк не идут: steam — это скины, они уже
// посчитаны отдельной строкой по трекеру, и сложить их ещё раз значило бы
// удвоить инвентарь.
const BANK_SKIP_SOURCES = new Set(["steam"]);

const SOURCE_TITLES = {
  csfloat: "CSFloat",
  youpin: "Youpin898",
  buff: "Buff163",
  skinbux: "Skinbux",
  csmoney: "CS.Money",
  crypto: "Крипта",
};

function sourceTitle(source) {
  return SOURCE_TITLES[source] || source.charAt(0).toUpperCase() + source.slice(1);
}

/** Карточка площадки -> строка банка: сколько там всего наших денег. */
function balanceRows(balances) {
  const rows = [];
  for (const [source, b] of Object.entries(balances || {})) {
    if (BANK_SKIP_SOURCES.has(source)) continue;
    const active = Number(b.active) || 0;
    const hold = Number(b.hold) || 0;
    const frozen = Number(b.frozen) || 0;
    const value = round2(active + hold + frozen);
    if (!value) continue;

    const notes = [];
    if (hold) notes.push(`в холде ${hold.toFixed(2)}`);
    if (frozen) notes.push(`заморожено ${frozen.toFixed(2)}`);
    if (b.source === "api") notes.push("из API");
    rows.push({ source, title: sourceTitle(source), value, active, hold, frozen, note: notes.join(" · ") });
  }
  return rows.sort((a, b) => b.value - a.value);
}

async function collectBank({ state, rows, config, owner, balances = {}, owedToMe = 0, refresh = false }) {
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

  // Список транзакций нужен только ради долга друзьям (сумма, которая реально
  // пришла за их предметы). Не ответил — считаем по нашей записи из журнала и
  // не роняем весь банк из-за этого.
  let transactions = [];
  try {
    transactions = await skinbuxAccount.fetchTransactions(process.env.SKINBUX_API_KEY);
  } catch (err) {
    errors.push(`Транзакции Skinbux (нужны для долга друзьям): ${err.message}`);
  }

  const money = balanceRows(balances);
  for (const row of money) {
    if (row.source === "csfloat" && balances.csfloat?.source === "error") {
      errors.push(`Баланс CSFloat не прочитан: ${balances.csfloat.error || "нет ответа"}`);
    }
  }

  const liabilities = clientLiabilities(transactions);
  const moneyTotal = round2(money.reduce((sum, r) => sum + r.value, 0));
  const debtsToUs = round2(owedToMe);
  const assets = round2(inventory.total + moneyTotal + debtsToUs);

  return {
    inventory,
    untracked,
    money,
    moneyTotal,
    owedToMe: debtsToUs,
    liabilities,
    assets,
    total: round2(assets - liabilities.total),
    collectedAt: new Date().toISOString(),
    errors,
  };
}

module.exports = { collectBank, valueTracker, untrackedSteamItems, clientLiabilities, instantSellValue };
