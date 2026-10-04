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
const trades = require("./trades");

const DEFAULT_DAYS = 90;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Идентификатор конкретного предмета внутри транзакции — для защиты от повторов. */
function itemExternalId(txId, index) {
  return `skinbux:${txId}:${index}`;
}

/**
 * Открытые позиции по названию, от старых к новым: продаём то, что куплено
 * раньше (FIFO) — так прибыль по партии считается привычным образом.
 */
function buildHoldingsIndex(rawTrades) {
  const index = new Map();
  for (const t of rawTrades) {
    if (t.status !== "holding") continue;
    const list = index.get(t.marketHashName) || [];
    list.push(t);
    index.set(t.marketHashName, list);
  }
  for (const list of index.values()) list.sort((a, b) => new Date(a.buyDate) - new Date(b.buyDate));
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
 */
function planImport({ transactions, journal, rawTrades, days = DEFAULT_DAYS, ownerSteamId }) {
  const cutoff = Date.now() - Math.max(1, Number(days) || DEFAULT_DAYS) * 86400000;
  const journalById = new Map(journal.map((s) => [String(s.id), s]));
  const holdings = buildHoldingsIndex(rawTrades);
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
      const holding = list?.shift();
      if (!holding) {
        rows.push({ ...base, status: "nomatch" });
        return;
      }

      rows.push({
        ...base,
        status: "match",
        holdingId: holding.id,
        buyPrice: round2(holding.buyPrice),
        buyDate: holding.buyDate,
        profit: round2(price - holding.buyPrice),
      });
    });
  }

  const sum = (filter) => round2(rows.filter(filter).reduce((acc, r) => acc + r.price, 0));
  return {
    rows,
    days: Math.max(1, Number(days) || DEFAULT_DAYS),
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
