// Импорт продаж со Skinbux в трекер сделок — то же, что импорт покупок с
// CSFloat, только с другой стороны: там позиции открываются, здесь
// закрываются.
//
// Зачем: когда продаёшь свои скины со своего аккаунта, в трекере позиция так
// и висит открытой, пока не отметишь продажу руками. Из-за этого и прибыль
// неполная, и в раскладе холда такие деньги висят как "не подтверждено".
//
// Чего в API нет: steamId продавца. Он виден в их веб-интерфейсе, но ни
// /account/transactions, ни /transaction/status/:id его не отдают — проверено.
// Поэтому свои продажи отделяем от чужих по нашему же журналу (skinbuxSales):
// если транзакция в журнале и steamId там чужой — это продажа клиента или
// друга, её не трогаем. Всё остальное — наше.
//
// Какой из одинаковых скинов продан — отдельный вопрос: float продажи Skinbux
// тоже не отдаёт. Его решает tradeFloats.js по инвентарю: позиция, чей float
// всё ещё лежит в инвентаре, продана быть не могла, а та, чьего float там
// больше нет, — как раз проданная.
const trades = require("./trades");
const tradeFloats = require("./tradeFloats");
const { stripPhaseSuffix } = require("./itemName");

const DEFAULT_DAYS = 90;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Идентификатор конкретного предмета внутри транзакции — для защиты от повторов. */
function itemExternalId(txId, index) {
  return `skinbux:${txId}:${index}`;
}

/**
 * Открытые позиции по названию в том порядке, в котором их стоит закрывать.
 *
 * Сначала те, чей float известен, а в инвентаре его больше нет: это ровно те
 * предметы, которых у нас не осталось, то есть проданные. Потом те, про float
 * которых мы ничего не знаем (старые записи, ручной ввод) — среди них выбираем
 * по FIFO, как и раньше. В самом конце те, чей предмет инвентарь показывает на
 * месте: закрывать их почти наверняка неправильно, но если продажу закрывать
 * больше нечем, пусть лучше строка попадёт в предпросмотр с пометкой, чем
 * продажа потеряется молча.
 *
 * Внутри каждой кучки — от старых покупок к новым.
 */
function buildHoldingsIndex(rawTrades, inventory) {
  const invFloats = tradeFloats.floatsByName(inventory);
  const byName = new Map();
  for (const t of rawTrades) {
    if (t.status !== "holding") continue;
    const list = byName.get(t.marketHashName) || [];
    list.push(t);
    byName.set(t.marketHashName, list);
  }

  const index = new Map();
  for (const [name, positions] of byName) {
    positions.sort((a, b) => new Date(a.buyDate) - new Date(b.buyDate));
    // null вместо списка — инвентарь недоступен: тогда про float ничего не
    // утверждаем и работаем как раньше. Пустой список — инвентарь есть, но
    // предметов с таким названием в нём нет, и это уже содержательный ответ.
    const floats = inventory ? invFloats.get(name) || [] : null;
    // Предмет в трейд-бане Skinbux в инвентаре не показывает — "его там нет"
    // про такую позицию не значит ничего. Продать её тоже было нельзя,
    // поэтому в очереди на закрытие она последняя.
    const locked = inventory ? positions.filter((p) => p.isLocked === true) : [];
    const free = inventory ? positions.filter((p) => p.isLocked !== true) : positions;
    const { held, gone, unknown } = tradeFloats.splitByInventory(free, floats);
    index.set(name, [
      ...gone.map((position) => ({ position, matchedBy: "float" })),
      ...unknown.map((position) => ({ position, matchedBy: "fifo" })),
      ...held.map((position) => ({ position, matchedBy: "held" })),
      ...locked.map((position) => ({ position, matchedBy: "locked" })),
    ]);
  }
  return index;
}

const MATCH_PRIORITY = ["float", "fifo", "held", "locked"];

/** Убрать конкретную запись из очередей индекса — её уже забрала продажа. */
function takeEntry(holdings, entry) {
  for (const list of holdings.values()) {
    const at = list.indexOf(entry);
    if (at >= 0) {
      list.splice(at, 1);
      return entry;
    }
  }
  return entry;
}

/**
 * Позиция под проданный предмет (и сразу убирает её из очереди).
 *
 * Площадка знает float проданного (CSFloat) — сначала ищем позицию ровно с
 * этим float: тут угадывать нечего, это тот самый предмет.
 *
 * Доплеры: в трекере название с фазой ("... (Factory New) - Ruby"), а Skinbux
 * в продаже пишет просто "... (Factory New)" — фазу отдаёт отдельным полем, а
 * бывает, что и не отдаёт. Есть фаза — ищем точно по ней, а если такой нет —
 * ту же вещь, записанную в трекере без фазы (ручные сделки так и заводятся),
 * но не другую фазу. Нет фазы — сначала запись без фазы, потом среди всех фаз
 * этого предмета: первой позиция, чьего float уже нет в инвентаре (это и есть
 * проданная), дальше по тому же порядку, что и обычно.
 */
function pickHolding(holdings, item) {
  const names = item.phase ? [`${item.name} - ${item.phase}`, item.name] : [item.name];

  if (item.float != null) {
    const sameItem = [...holdings]
      .filter(([name]) => names.includes(name) || (!item.phase && stripPhaseSuffix(name).base === item.name))
      .flatMap(([, list]) => list);
    const exact = sameItem.find((entry) => tradeFloats.sameFloat(entry.position.floatValue, item.float));
    if (exact) return { ...takeEntry(holdings, exact), matchedBy: "exact" };
  }

  for (const name of names) {
    const list = holdings.get(name);
    if (list?.length) return list.shift();
  }
  if (item.phase || stripPhaseSuffix(item.name).phase) return null;

  const phased = [...holdings].filter(([name, list]) => list.length && name !== item.name && stripPhaseSuffix(name).base === item.name);
  for (const by of MATCH_PRIORITY) {
    const hit = phased.find(([, list]) => list[0].matchedBy === by);
    if (hit) return hit[1].shift();
  }
  return null;
}

/**
 * Продажи Skinbux -> общий вид продажи для planSales. Пропускает
 * незавершённые и продажи клиентов и друга через сайт: они учтены отдельно,
 * и предметы там не наши.
 */
function salesFromSkinbux(transactions, { journal, ownerSteamId }) {
  const journalById = new Map(journal.map((s) => [String(s.id), s]));
  const sales = [];
  for (const tx of transactions) {
    if (tx.status !== "completed") continue;
    const sale = journalById.get(String(tx.id));
    if (sale && String(sale.steamId) !== String(ownerSteamId)) continue;
    const soldAt = new Date(tx.updatedAt || tx.createdAt).toISOString();
    (tx.tradeItems || []).forEach((item, index) => {
      sales.push({
        externalId: itemExternalId(tx.id, index),
        txId: tx.id,
        name: item.name,
        phase: item.phase || null,
        float: null, // Skinbux float продажи не отдаёт
        price: round2((Number(item.price) || 0) / 100),
        soldAt,
        viaSite: !!sale,
      });
    });
  }
  return sales;
}

/**
 * Что импорт собирается сделать. Ничего не пишет — это то, что видно в
 * предпросмотре до подтверждения.
 *
 * sales — проданные предметы в общем виде:
 *   { externalId, name (без фазы), phase, float, price (до комиссии), soldAt }.
 * source — площадка продажи (skinbux, csfloat): так позиция и закроется.
 * feeRate — комиссия площадки: прибыль в предпросмотре — с ней, как и в
 * трекере после закрытия (trades.sellTrade вычитает её сам).
 *
 * Для каждого проданного предмета одна строка:
 *   match   — нашли открытую позицию, закроем её по цене продажи;
 *   already — уже импортировано раньше (по sellExternalId);
 *   nomatch — такого предмета в трекере нет, занести нечего.
 *
 * matchedBy говорит, чем именно выбрана позиция: "exact" — float продажи
 * совпал с float позиции, "float" — предмета с таким float в инвентаре
 * больше нет, "fifo" — float неизвестен, взяли самую раннюю покупку, "held" —
 * инвентарь уверяет, что предмет на месте, и других вариантов не осталось.
 */
function planSales({ sales, rawTrades, days = DEFAULT_DAYS, inventory = null, source = "skinbux", feeRate = 0 }) {
  const cutoff = Date.now() - Math.max(1, Number(days) || DEFAULT_DAYS) * 86400000;
  const holdings = buildHoldingsIndex(rawTrades, inventory);
  const importedIds = new Set(rawTrades.filter((t) => t.sellExternalId).map((t) => t.sellExternalId));

  const rows = [];
  for (const item of sales) {
    if (!(new Date(item.soldAt).getTime() >= cutoff)) continue;
    const net = round2(item.price * (1 - feeRate));
    const base = {
      externalId: item.externalId,
      txId: item.txId ?? null,
      source,
      // С фазой, если площадка её отдала: в предпросмотре видно, какой доплер продан.
      marketHashName: item.phase ? `${item.name} - ${item.phase}` : item.name,
      price: item.price,
      net,
      soldFloat: item.float ?? null,
      soldAt: item.soldAt,
      viaSite: !!item.viaSite,
    };

    if (importedIds.has(item.externalId)) {
      rows.push({ ...base, status: "already" });
      continue;
    }

    const pick = pickHolding(holdings, item);
    if (!pick) {
      rows.push({ ...base, status: "nomatch" });
      continue;
    }

    const holding = pick.position;
    rows.push({
      ...base,
      status: "match",
      matchedBy: pick.matchedBy,
      holdingId: holding.id,
      floatValue: holding.floatValue ?? null,
      buyPrice: round2(holding.buyPrice),
      buyDate: holding.buyDate,
      profit: round2(net - holding.buyPrice),
    });
  }

  const sum = (filter) => round2(rows.filter(filter).reduce((acc, r) => acc + r.price, 0));
  const countBy = (by) => rows.filter((r) => r.status === "match" && r.matchedBy === by).length;
  return {
    rows,
    source,
    days: Math.max(1, Number(days) || DEFAULT_DAYS),
    // Работало ли сопоставление по float вообще: без инвентаря это обычный FIFO,
    // и в интерфейсе об этом честно написано.
    floatMatching: !!inventory,
    byExact: countBy("exact"),
    byFloat: countBy("float"),
    byFifo: countBy("fifo"),
    byHeld: countBy("held"),
    matched: rows.filter((r) => r.status === "match").length,
    matchedSum: sum((r) => r.status === "match"),
    profit: round2(rows.filter((r) => r.status === "match").reduce((acc, r) => acc + r.profit, 0)),
    already: rows.filter((r) => r.status === "already").length,
    nomatch: rows.filter((r) => r.status === "nomatch").length,
    nomatchSum: sum((r) => r.status === "nomatch"),
  };
}

/** Старый вход для Skinbux: транзакции как есть. */
function planImport({ transactions, journal, rawTrades, days = DEFAULT_DAYS, ownerSteamId, inventory = null }) {
  const sales = salesFromSkinbux(transactions, { journal, ownerSteamId });
  return planSales({ sales, rawTrades, days, inventory, source: "skinbux" });
}

/** Закрывает позиции по плану. Возвращает, сколько получилось и что нет. */
function applyImport(plan, { owner, sourcesConfig }) {
  let closed = 0;
  const failed = [];
  for (const row of plan.rows) {
    if (row.status !== "match") continue;
    try {
      trades.sellTrade(
        row.holdingId,
        owner,
        {
          sellSource: row.source || plan.source || "skinbux",
          sellPrice: row.price,
          sellDate: row.soldAt,
          // Skinbux — выкуп по bid; на CSFloat у нас купили наш лот, то есть по ask.
          sellSide: (row.source || plan.source) === "csfloat" ? "ask" : "bid",
          sellExternalId: row.externalId,
        },
        sourcesConfig
      );
      closed++;
    } catch (err) {
      failed.push(`${row.marketHashName}: ${err.message}`);
    }
  }
  return { closed, failed };
}

module.exports = { planSales, salesFromSkinbux, planImport, applyImport, DEFAULT_DAYS };
