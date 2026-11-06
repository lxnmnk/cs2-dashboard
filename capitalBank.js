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
 * Сколько из денег на Skinbux не наши — по той же раскладке, что показывает
 * карточка Skinbux в My Trades (skinbuxAccount.splitHold).
 *
 * Раскладка смотрит на деньги, которые лежат на счету сейчас, и делит их на
 * три части: мои, друга и клиентские. Именно это и надо вычесть: клиенту мы
 * должны его выплату, другу — всю сумму за его предметы, а маржа с клиентской
 * продажи остаётся нам.
 *
 * Чего делать нельзя (пробовали, вышло неверно): складывать все записи
 * журнала без отметки "выплачено" за всю историю. Там лежит и то, что давно
 * вернули не отметив, и долг друга раздувался до $4845 при настоящих $310.
 */
function holdLiabilities(split) {
  if (!split) return { payout: 0, tradeCredit: 0, partners: {}, partnersTotal: 0, total: 0 };

  const partners = { ...(split.partners || {}) };
  const partnersTotal = round2(Object.values(partners).reduce((sum, v) => sum + v, 0));
  const payout = round2(split.clients?.payout || 0);
  return { payout, tradeCredit: 0, partners, partnersTotal, total: round2(payout + partnersTotal) };
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
  // Не мешает посчитать банк: сверка со Steam только показывает, чего нет в
  // трекере, в сумму она не входит. Ошибки (errors) — то, без чего банк неверен.
  const warnings = [];

  // Инвентарь считаем по трекеру сделок, а Steam используем только для
  // сверки: не потерялось ли что-то, чего в трекере нет.
  const inventory = valueTracker({ owner, rows, config });
  let untracked = { count: 0, value: 0, names: [] };
  try {
    const items = await fetchInventory(state.steamId, { force: refresh });
    untracked = untrackedSteamItems(items, { owner, rows, sourcesConfig: config.sources });
  } catch (err) {
    warnings.push(`Сверка с инвентарём Steam не вышла: ${err.message}`);
  }

  const money = balanceRows(balances);
  for (const row of money) {
    if (row.source === "csfloat" && balances.csfloat?.source === "error") {
      errors.push(`Баланс CSFloat не прочитан: ${balances.csfloat.error || "нет ответа"}`);
    }
  }

  // Чужие деньги физически лежат на Skinbux: клиентам мы ещё не выплатили, а
  // деньги друга за его продажи просто пришли на наш счёт. Вычитаем их прямо
  // из этой строки — в банк должно идти то, что на Skinbux действительно наше.
  //
  // Берём ровно ту раскладку, что показывает карточка Skinbux в My Trades
  // (skinbuxAccount.splitHold): она смотрит на деньги, которые лежат на счету
  // сейчас. Считать долг иначе — сложением всех незакрытых записей журнала за
  // всю историю — нельзя: там и давно возвращённое, и долг друга вырастал до
  // $4845 вместо настоящих $310.
  const liabilities = holdLiabilities(balances.skinbux?.holdSplit);
  const skinbux = money.find((m) => m.source === "skinbux");
  let leftover = liabilities.total;
  if (skinbux && leftover) {
    const gross = skinbux.value;
    const subtracted = Math.min(gross, leftover);
    skinbux.gross = gross;
    skinbux.deducted = round2(subtracted);
    skinbux.value = round2(gross - subtracted);
    leftover = round2(leftover - subtracted);
    const parts = [`всего ${gross.toFixed(2)}`];
    if (liabilities.payout || liabilities.tradeCredit) {
      parts.push(`клиентам ${round2(liabilities.payout + liabilities.tradeCredit).toFixed(2)}`);
    }
    for (const [name, amount] of Object.entries(liabilities.partners || {})) parts.push(`${name} ${amount.toFixed(2)}`);
    skinbux.note = `минус чужое: ${parts.join(" · ")}`;
    // Для инвестора то же самое, но без имён.
    skinbux.publicNote = `за вычетом чужих денег (${liabilities.total.toFixed(2)} из ${gross.toFixed(2)})`;
  }

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
    // Чужих денег оказалось больше, чем лежит на Skinbux: остаток вычитаем из
    // банка целиком — отдавать его всё равно придётся.
    leftoverDebt: leftover,
    assets,
    total: round2(assets - leftover),
    collectedAt: new Date().toISOString(),
    errors,
    warnings,
  };
}

module.exports = { collectBank, valueTracker, untrackedSteamItems, holdLiabilities, instantSellValue };
