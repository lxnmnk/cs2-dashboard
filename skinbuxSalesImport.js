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
    const { held, gone, unknown } = tradeFloats.splitByInventory(positions, floats);
    index.set(name, [
      ...gone.map((position) => ({ position, matchedBy: "float" })),
      ...unknown.map((position) => ({ position, matchedBy: "fifo" })),
      ...held.map((position) => ({ position, matchedBy: "held" })),
    ]);
  }
  return index;
}

/**
 * Что импорт собирается сделать. Ничего не пишет — это то, что видно в
 * предпросмотре до подтверждения.
 *
 * Для каждого проданного предмета одна строка:
 *   match   — нашли открытую позицию, закроем её по цене продажи;
 *   already — уже импортировано раньше (по sellExternalId);
 *   nomatch — такого предмета в трекере нет, занести нечего.
 *
 * matchedBy говорит, чем именно выбрана позиция: "float" — предмета с таким
 * float в инвентаре больше нет (самый надёжный случай), "fifo" — float
 * неизвестен, взяли самую раннюю покупку, "held" — инвентарь уверяет, что
 * предмет на месте, и других вариантов не осталось.
 */
function planImport({ transactions, journal, rawTrades, days = DEFAULT_DAYS, ownerSteamId, inventory = null }) {
  const cutoff = Date.now() - Math.max(1, Number(days) || DEFAULT_DAYS) * 86400000;
  const journalById = new Map(journal.map((s) => [String(s.id), s]));
  const holdings = buildHoldingsIndex(rawTrades, inventory);
  const importedIds = new Set(rawTrades.filter((t) => t.sellExternalId).map((t) => t.sellExternalId));

  const rows = [];
  for (const tx of transactions) {
    if (tx.status !== "completed") continue;
    const soldAt = new Date(tx.updatedAt || tx.createdAt);
    if (!(soldAt.getTime() >= cutoff)) continue;

    // Продажа клиента или друга через сайт — она уже учтена отдельно, и
    // предметы там не наши.
    const sale = journalById.get(String(tx.id));
    if (sale && String(sale.steamId) !== String(ownerSteamId)) continue;

    (tx.tradeItems || []).forEach((item, index) => {
      const externalId = itemExternalId(tx.id, index);
      const price = round2((Number(item.price) || 0) / 100);
      const base = {
        externalId,
        txId: tx.id,
        marketHashName: item.name,
        price,
        soldAt: soldAt.toISOString(),
        viaSite: !!sale,
      };

      if (importedIds.has(externalId)) {
        rows.push({ ...base, status: "already" });
        return;
      }

      const list = holdings.get(item.name);
      const pick = list?.shift();
      if (!pick) {
        rows.push({ ...base, status: "nomatch" });
        return;
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
        profit: round2(price - holding.buyPrice),
      });
    });
  }

  const sum = (filter) => round2(rows.filter(filter).reduce((acc, r) => acc + r.price, 0));
  const countBy = (by) => rows.filter((r) => r.status === "match" && r.matchedBy === by).length;
  return {
    rows,
    days: Math.max(1, Number(days) || DEFAULT_DAYS),
    // Работало ли сопоставление по float вообще: без инвентаря это обычный FIFO,
    // и в интерфейсе об этом честно написано.
    floatMatching: !!inventory,
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
          sellSource: "skinbux",
          sellPrice: row.price,
          sellDate: row.soldAt,
          sellSide: "bid",
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

module.exports = { planImport, applyImport, DEFAULT_DAYS };
